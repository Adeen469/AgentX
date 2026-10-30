"use client";

import { useEffect } from "react";

// Old live links used /#workspace, /#review, and so on. The app no longer
// uses hash routing at all, so send those links to the real /app/* paths.
const HASH_PAGES: Record<string, string> = {
  investigate: "/app",
  workspace: "/app/workspace",
  review: "/app/review",
  repositories: "/app/repositories",
  settings: "/app/settings",
};

export default function HashRedirect() {
  useEffect(() => {
    const target = HASH_PAGES[window.location.hash.slice(1)];
    if (target) window.location.replace(target);
  }, []);
  return null;
}
