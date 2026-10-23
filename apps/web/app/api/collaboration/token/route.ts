import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cookieNames, createCollaborationToken, readSession } from "../../../../lib/auth";

export const runtime = "nodejs";

export function GET() {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  return NextResponse.json({ token: createCollaborationToken(user) });
}
