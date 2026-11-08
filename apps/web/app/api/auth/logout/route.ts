import { NextResponse } from "next/server";
import { assertSameOrigin, clearCookie } from "../../../../lib/auth";

export const runtime = "nodejs";

export function POST(request: Request) {
  // Logout clears the victim's own cookie, so a cross-origin POST that
  // triggers it is a logout-CSRF. SameSite=Lax already blocks the cookie
  // on cross-site POSTs; the origin check is defense-in-depth.
  try {
    assertSameOrigin(request);
  } catch {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearCookie());
  return response;
}
