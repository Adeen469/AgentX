import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
  provider: "github";
  githubAccessToken?: string;
}

const sessionCookie = "agentx_session";
const stateCookie = "agentx_oauth_state";

// Sessions live 7 days; a session older than the rotation window is
// re-issued (sliding renewal) by GET /api/auth/session so a stolen
// cookie has a bounded useful life and active users are not logged out.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ROTATION_MS = 24 * 60 * 60 * 1000;

// AUTH_SECRET signs every session and approval token. A short or
// guessable secret lets anyone forge sessions, so anything weak or
// placeholder-shaped is rejected loudly instead of silently accepted.
const MIN_AUTH_SECRET_LENGTH = 32;
const WEAK_AUTH_SECRETS = new Set([
  "secret",
  "changeme",
  "change-me",
  "change_me",
  "password",
  "test",
  "testing",
  "dev",
  "development",
  "default",
  "agentx",
  "agentx-secret",
  "your_auth_secret",
  "your_secret",
  "replace-me",
  "replace_me",
  "placeholder",
]);

export function requireAuthSecret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    throw new Error(
      "AUTH_SECRET is not configured. Set a random value of at least 32 characters (e.g. `openssl rand -hex 32`)."
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters (got ${trimmed.length}). Generate a fresh random secret; short secrets let anyone forge sessions.`
    );
  }
  const lowered = trimmed.toLowerCase();
  if (
    WEAK_AUTH_SECRETS.has(lowered) ||
    lowered.includes("your_") ||
    lowered.includes("******") ||
    lowered.includes("changeme") ||
    lowered.includes("change-me") ||
    /^(.)\1+$/.test(trimmed) || // e.g. "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    /^(.{1,8})\1+.{0,4}$/.test(trimmed) // e.g. "secretsecretsecretsecretsecret12"
  ) {
    throw new Error(
      "AUTH_SECRET looks like a placeholder or weak default value. Replace it with a randomly generated secret of at least 32 characters."
    );
  }
  return trimmed;
}

function requireEnv(name: string): string {
  const value = process.env[name] || (name === "GITHUB_CLIENT_ID" ? process.env.GITHUB_Client_ID : name === "GITHUB_CLIENT_SECRET" ? process.env.GITHUB_Client_Secret : undefined);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", requireAuthSecret()).update(value).digest("base64url");
}

export function cookieNames() {
  return { sessionCookie, stateCookie };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionInfo {
  user: AuthUser;
  /** Epoch ms the session was minted; absent on sessions minted before rotation was added. */
  issuedAt: number | null;
  /** True when the session is past the rotation window and should be re-issued. */
  needsRotation: boolean;
}

export function createSession(user: AuthUser): string {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ user, iat: now, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSessionInfo(value: string | undefined): SessionInfo | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user: AuthUser; iat?: number; exp: number };
    if (parsed.exp <= Date.now()) return null;
    // Only GitHub sessions are valid now; a session minted by the removed provider flow is rejected.
    if (parsed.user.provider !== "github") return null;
    // Reject sessions minted in the future (clock skew beyond 5 minutes) — a forged/clocked payload.
    const issuedAt = typeof parsed.iat === "number" ? parsed.iat : null;
    if (issuedAt !== null && issuedAt > Date.now() + 5 * 60 * 1000) return null;
    // Sessions minted before `iat` existed have no rotation signal; treat them as due for rotation.
    const needsRotation = issuedAt === null || Date.now() - issuedAt >= SESSION_ROTATION_MS;
    return { user: parsed.user, issuedAt, needsRotation };
  } catch {
    return null;
  }
}

export function readSession(value: string | undefined): AuthUser | null {
  return readSessionInfo(value)?.user ?? null;
}

/**
 * Defense-in-depth CSRF check for state-changing routes. The session
 * cookie is SameSite=Lax, which already blocks cross-site POSTs from
 * carrying it; this rejects any same-site/forged request whose Origin
 * (or, failing that, Referer) does not match this app's origin. Requests
 * with neither header (curl, server-to-server) are allowed — they carry
 * no browser ambient authority.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const expected = new URL(request.url).origin;
  const candidate = origin || referer;
  if (candidate && new URL(candidate).origin !== expected) {
    throw new Error("Cross-origin request rejected.");
  }
}

export function secureCookie(value: string, maxAge: number): string {
  // NB: `Secure` is a valueless flag — the old `Secure=false` form was
  // malformed (some browsers treat any presence as Secure, which would
  // have blocked the cookie over plain http://localhost in development).
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${value}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

export function clearCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`;
}

export async function exchangeGithubCode(code: string, redirectUri: string): Promise<AuthUser> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("GITHUB_CLIENT_ID"),
      client_secret: requireEnv("GITHUB_CLIENT_SECRET"),
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenResponse.ok) throw new Error("GitHub authorization code exchange failed.");
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) throw new Error("GitHub did not return an access token.");
  const profileResponse = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "AgentX" }
  });
  if (!profileResponse.ok) throw new Error("GitHub profile lookup failed.");
  const profile = await profileResponse.json() as { id?: number; login?: string; name?: string; email?: string; avatar_url?: string };
  if (!profile.id || !profile.login) throw new Error("GitHub profile is incomplete.");
  return {
    id: `github:${profile.id}`,
    email: profile.email || `${profile.login}@users.noreply.github.com`,
    name: profile.name || profile.login,
    picture: profile.avatar_url,
    provider: "github",
    githubAccessToken: token.access_token
  };
}
