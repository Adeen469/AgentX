import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthUser } from "./auth";

function secret() {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not configured.");
  return process.env.AUTH_SECRET;
}

export function createApproval(user: AuthUser, action: "push_branch" | "open_pull_request", payload: Record<string, unknown>) {
  const data = Buffer.from(JSON.stringify({ userId: user.id, action, payload, exp: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function verifyApproval(token: string, user: AuthUser, action: string) {
  const [data, signature] = token.split(".");
  if (!data || !signature) throw new Error("Invalid approval token.");
  const expected = createHmac("sha256", secret()).update(data).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid approval signature.");
  const approval = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { userId: string; action: string; payload: Record<string, unknown>; exp: number };
  if (approval.userId !== user.id || approval.action !== action || approval.exp <= Date.now()) throw new Error("Approval is expired or does not match this action.");
  return approval.payload;
}
