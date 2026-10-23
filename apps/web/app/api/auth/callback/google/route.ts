import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cookieNames, createSession, exchangeGoogleCode, secureCookie } from "../../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get(cookieNames().stateCookie)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.json({ error: "Invalid OAuth callback state." }, { status: 400 });
  }
  try {
    const user = await exchangeGoogleCode(code, process.env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/callback/google`);
    const response = NextResponse.redirect(new URL("/", request.url));
    response.headers.append("Set-Cookie", `agentx_session=${secureCookie(createSession(user), 7 * 24 * 60 * 60)}`);
    response.headers.append("Set-Cookie", `${cookieNames().stateCookie}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Google sign-in failed." }, { status: 502 });
  }
}
