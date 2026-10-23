import { NextResponse } from "next/server";
import { cookieNames, createOAuthState, secureCookie } from "../../../../lib/auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID || process.env.GITHUB_Client_ID;
  const redirectUri = process.env.GITHUB_REDIRECT_URI || `${new URL(request.url).origin}/api/auth/callback/github`;
  if (!clientId) return NextResponse.json({ error: "GitHub OAuth is not configured." }, { status: 503 });
  const state = createOAuthState();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: "read:user user:email repo", state }).toString();
  const response = NextResponse.redirect(url);
  response.headers.set("Set-Cookie", `${cookieNames().stateCookie}=${secureCookie(state, 600)}`);
  return response;
}
