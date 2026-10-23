import { readdir } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { safeWorkspacePath } from "../../../../lib/workspace";

export const runtime = "nodejs";

const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

async function listFiles(workspace: string, relative = "", depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const directory = safeWorkspacePath(workspace, relative || ".");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(workspace, child, depth + 1));
    else files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

export async function GET(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const workspace = new URL(request.url).searchParams.get("workspace");
  if (!workspace) return NextResponse.json({ error: "Workspace is required." }, { status: 400 });
  try {
    return NextResponse.json({ files: await listFiles(workspace) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace listing failed." }, { status: 400 });
  }
}
