import { readFile, writeFile } from "node:fs/promises";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieNames, readSession } from "../../../../lib/auth";
import { safeWorkspacePath } from "../../../../lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const url = new URL(request.url);
  const workspace = url.searchParams.get("workspace");
  const filePath = url.searchParams.get("path");
  if (!workspace || !filePath) return NextResponse.json({ error: "Workspace and path are required." }, { status: 400 });
  try {
    return NextResponse.json({ content: await readFile(safeWorkspacePath(workspace, filePath), "utf8") });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "File read failed." }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  if (!readSession(cookies().get(cookieNames().sessionCookie)?.value)) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const input = await request.json() as { workspace?: string; path?: string; content?: string };
  if (!input.workspace || !input.path || typeof input.content !== "string") return NextResponse.json({ error: "Workspace, path, and content are required." }, { status: 400 });
  try {
    await writeFile(safeWorkspacePath(input.workspace, input.path), input.content, "utf8");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "File write failed." }, { status: 400 });
  }
}
