import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  cookieNames,
  createSession,
  readSessionInfo,
  secureCookie,
  SESSION_TTL_MS,
} from "../../../../lib/auth";

export const runtime = "nodejs";

export function GET() {
  const raw = cookies().get(cookieNames().sessionCookie)?.value;
  const session = readSessionInfo(raw);
  const response = NextResponse.json({ user: session?.user ?? null });
  // Sliding rotation: a session older than the rotation window gets a
  // fresh cookie (new iat + expiry) so long-lived sessions are regularly
  // re-minted and a stolen cookie stops working after at most one window
  // past the victim's last activity.
  if (session?.needsRotation) {
    response.headers.set(
      "Set-Cookie",
      `${cookieNames().sessionCookie}=${secureCookie(createSession(session.user), SESSION_TTL_MS / 1000)}`
    );
  }
  return response;
}
