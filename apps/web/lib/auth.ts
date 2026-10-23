import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
  provider: "google" | "github";
  githubAccessToken?: string;
}

const sessionCookie = "agentx_session";
const stateCookie = "agentx_oauth_state";

function requireEnv(name: string): string {
  const value = process.env[name] || (name === "GITHUB_CLIENT_ID" ? process.env.GITHUB_Client_ID : name === "GITHUB_CLIENT_SECRET" ? process.env.GITHUB_Client_Secret : undefined);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", requireEnv("AUTH_SECRET")).update(value).digest("base64url");
}

export function cookieNames() {
  return { sessionCookie, stateCookie };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createSession(user: AuthUser): string {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function createCollaborationToken(user: AuthUser): string {
  const collaborationUser = { id: user.id, email: user.email, name: user.name, picture: user.picture, provider: user.provider };
  const payload = Buffer.from(JSON.stringify({ user: collaborationUser, exp: Date.now() + 5 * 60 * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSession(value: string | undefined): AuthUser | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user: AuthUser; exp: number };
    return parsed.exp > Date.now() ? parsed.user : null;
  } catch {
    return null;
  }
}

export function secureCookie(value: string, maxAge: number): string {
  return `${value}; HttpOnly; Path=/; SameSite=Lax; Secure=${process.env.NODE_ENV === "production"}; Max-Age=${maxAge}`;
}

export function clearCookie(): string {
  return `${sessionCookie}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<AuthUser> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!tokenResponse.ok) throw new Error("Google authorization code exchange failed.");
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) throw new Error("Google did not return an access token.");
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  if (!profileResponse.ok) throw new Error("Google profile lookup failed.");
  const profile = await profileResponse.json() as { sub?: string; email?: string; name?: string; picture?: string };
  if (!profile.sub || !profile.email || !profile.name) throw new Error("Google profile is incomplete.");
  return { id: profile.sub, email: profile.email, name: profile.name, picture: profile.picture, provider: "google" };
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
