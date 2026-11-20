/**
 * The request side of /api/my/meetings/** (docs/meetings.md, "The gate"):
 * the signed-in session only (no API token: a request with an Authorization
 * header is 404, and the dev bridge is not wired), the `dev` grant and the
 * flag `meetings.record`, else 404; 503 off D1. Hands the routes a MeetDeps
 * for the caller's own account.
 */
import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { readConfig } from "@/lib/config-store";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { DEV_BRIDGE_HEADER } from "@/lib/dev-bridge";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { meetingsKey } from "./seal";
import { type MeetDeps, type Out, type R2Like, r2MeetBlobs } from "./store";

export const NO_STORE = { "cache-control": "private, no-store" };
export const notFound = () =>
  NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });
export const answer = (o: Out) =>
  NextResponse.json(o.json, { status: o.status, headers: NO_STORE });

/** Flag and grant for a page or a route: the account may use meetings. */
export async function meetingsOpen(email: string | null | undefined): Promise<boolean> {
  if (!isDev(email ?? null)) return false;
  if (dbBackend() !== "d1") return false;
  return flagIn(await readFlags(), "meetings.record");
}

export async function meetingDeps(req: Request): Promise<MeetDeps | Response> {
  if (req.headers.has("authorization") || req.headers.has(DEV_BRIDGE_HEADER)) return notFound();
  const user = await authUserOrNull();
  const uid = (user?.id as string | undefined) ?? null;
  if (!uid || !isDev(user?.email ?? null)) return notFound();
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "meetings-off" }, { status: 503, headers: NO_STORE });
  if (!flagIn(await readFlags(), "meetings.record")) return notFound();
  const c = await readConfig();
  return {
    uid,
    db: getD1(),
    blobs: r2MeetBlobs(getBlobs() as unknown as R2Like),
    key: () => meetingsKey(process.env.AUTH_SECRET),
    limits: {
      quotaBytes: c["meetings.quotaGB"] * 1e9,
      maxMs: c["meetings.maxMinutes"] * 60_000,
      chunkMs: c["meetings.chunkSec"] * 1000,
    },
  };
}

/** A JSON body of at most `max` bytes, or null. */
export async function jsonBody(req: Request, max: number): Promise<unknown | Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) return answer({ status: 413, json: { error: "too-large" } });
  const text = await req.text();
  if (text.length > max) return answer({ status: 413, json: { error: "too-large" } });
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
