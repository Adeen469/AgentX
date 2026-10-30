import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// AgentX is a single client shell, but its views have real paths:
// /workspace, /review, /repositories, /collaboration, /settings.
// Rewrite those paths to / (the shell) instead of 404ing, and let the
// shell pick the view from the URL. Unknown paths are not rewritten,
// so they still get Next's normal 404 instead of a blank page.
export function middleware(request: NextRequest) {
  return NextResponse.rewrite(new URL("/", request.url));
}

export const config = {
  matcher: ["/workspace", "/review", "/repositories", "/collaboration", "/settings"],
};
