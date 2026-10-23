import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cookieNames, readSession } from "../../../../lib/auth";

export const runtime = "nodejs";

export function GET() {
  const user = readSession(cookies().get(cookieNames().sessionCookie)?.value);
  return NextResponse.json({ user });
}
