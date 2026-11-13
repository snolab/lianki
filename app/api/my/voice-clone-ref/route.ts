import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import {
  type CloneRefDeps,
  MAX_PUT_BODY,
  type R2Like,
  cloneRefKey,
  d1CloneRefDb,
  deleteCloneRef,
  getCloneRef,
  putCloneRef,
  r2CloneRefBlobs,
} from "@/lib/voice-clone-ref";
import { importTicketVerifyKey } from "@/lib/voiceprint-ticket";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's own voice-clone reference (lib/voice-clone-ref.ts;
 * docs/voice-clone.md). The session cookie only: no API token reads or writes
 * it. 404 unless the flag `voice.clone` is on and the account holds `dev`
 * (the grant the voiceprint tickets need); 503 off D1 or without the secrets.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () =>
  NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });

async function deps(): Promise<CloneRefDeps | NextResponse> {
  const user = await authUserOrNull();
  if (!user?.id || !isDev(user.email)) return notFound();
  if (!flagIn(await readFlags(), "voice.clone")) return notFound();
  const raw = process.env.STT_TICKET_KEY;
  if (!raw || dbBackend() !== "d1")
    return NextResponse.json({ error: "voice-clone-off" }, { status: 503, headers: NO_STORE });
  return {
    uid: user.id as string,
    db: d1CloneRefDb(getD1()),
    blobs: r2CloneRefBlobs(getBlobs() as unknown as R2Like),
    key: () => cloneRefKey(process.env.AUTH_SECRET),
    pub: () => importTicketVerifyKey(raw),
  };
}

const answer = (o: { status: number; json: Record<string, unknown> }) =>
  NextResponse.json(o.json, { status: o.status, headers: NO_STORE });
const body = async (req: Request) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

export const GET = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  return answer(await getCloneRef(d, new URL(req.url).searchParams.get("audio") === "1"));
};

export const PUT = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  // Refuse an oversized body before reading it (a missing length is read, then checked whole).
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_PUT_BODY) return answer({ status: 413, json: { error: "too-large" } });
  const text = await req.text();
  if (text.length > MAX_PUT_BODY) return answer({ status: 413, json: { error: "too-large" } });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return answer(await putCloneRef(d, parsed));
};

export const DELETE = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  return answer(await deleteCloneRef(d, await body(req)));
};
