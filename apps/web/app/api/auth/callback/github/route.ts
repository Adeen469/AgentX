import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, createSession, exchangeGithubCode, secureCookie } from "../../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies().get(cookieNames().stateCookie)?.value) {
    return NextResponse.json({ error: "Invalid OAuth callback state." }, { status: 400 });
  }
  try {
    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${url.origin}/api/auth/callback/github`;
    const user = await exchangeGithubCode(code, redirectUri);
    const response = NextResponse.redirect(new URL("/app", request.url));
    response.headers.set("Set-Cookie", `agentx_session=${secureCookie(createSession(user), 7 * 24 * 60 * 60)}`);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "GitHub sign-in failed." }, { status: 502 });
  }
}
