import { NextResponse } from "next/server";
import { cookieNames, createOAuthState, secureCookie } from "../../../../lib/auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "Google OAuth is not configured." }, { status: 503 });
  }
  const state = createOAuthState();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "select_account"
  }).toString();
  const response = NextResponse.redirect(url);
  response.headers.append("Set-Cookie", `${cookieNames().stateCookie}=${secureCookie(state, 600)}`);
  return response;
}
