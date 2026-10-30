import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routing, with no hash fragments anywhere:
// - / is the landing page.
// - /app and /app/* are the app shell. They are rewritten to /app, so a
//   refresh or a direct link to /app/workspace never 404s, and the shell
//   picks the view from the URL with pushState navigation.
// - Legacy /workspace, /review, /repositories, /collaboration, /settings
//   and /investigate redirect to their /app/* equivalents.
// - Old /#workspace links are handled in the landing page (HashRedirect).
// - Unknown paths are not rewritten, so they still get Next's real 404.
const LEGACY: Record<string, string> = {
  "/workspace": "/app/workspace",
  "/review": "/app/review",
  "/repositories": "/app/repositories",
  "/collaboration": "/app/collaboration",
  "/settings": "/app/settings",
  "/investigate": "/app",
};

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return NextResponse.rewrite(new URL("/app", request.url));
  }
  const target = LEGACY[pathname];
  if (target) return NextResponse.redirect(new URL(target, request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/app/:path*", "/workspace", "/review", "/repositories", "/collaboration", "/settings", "/investigate"],
};
