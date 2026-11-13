import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { checkToken } from "@/lib/api-tokens";
import { readConfig } from "@/lib/config-store";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { refreshPermissions } from "@/lib/permission-store";
import { isDev } from "@/lib/permissions";
import {
  MAX_POST_BODY,
  type Out,
  type R2Like,
  type RecDeps,
  clipAudio,
  d1RecDb,
  dayArchive,
  deleteClip,
  deleteDay,
  getDay,
  listDays,
  postRecording,
  r2RecBlobs,
  recordingsKey,
} from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's own mic recordings (lib/recordings.ts;
 * docs/recordings.md). 404 unless the flag `voice.recordings` is on and the
 * account holds `dev`; 503 off D1. Writes and deletes take the session
 * cookie only; reads also take an API token with `recordings:read`
 * (scripts/dev/recordings-pull.ts), for that token's own account.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () =>
  NextResponse.json({ error: "not-found" }, { status: 404, headers: NO_STORE });

async function deps(req: Request, allowToken: boolean): Promise<RecDeps | NextResponse> {
  let uid: string | null = null;
  let email: string | null = null;
  const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer) {
    if (!allowToken || dbBackend() !== "d1") return notFound();
    const r = await checkToken(getD1() as unknown as D1Like, bearer, "recordings:read");
    if (!r.ok) return notFound();
    // A bearer token reads no session, so nothing has refreshed the grants yet.
    await refreshPermissions();
    uid = r.user.id;
    email = r.user.email;
  } else {
    const user = await authUserOrNull();
    uid = (user?.id as string | undefined) ?? null;
    email = user?.email ?? null;
  }
  if (!uid || !isDev(email)) return notFound();
  if (!flagIn(await readFlags(), "voice.recordings")) return notFound();
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "recordings-off" }, { status: 503, headers: NO_STORE });
  return {
    uid,
    db: d1RecDb(getD1()),
    blobs: r2RecBlobs(getBlobs() as unknown as R2Like),
    key: () => recordingsKey(process.env.AUTH_SECRET),
  };
}

const answer = (o: Out) => NextResponse.json(o.json, { status: o.status, headers: NO_STORE });

export const GET = async (req: Request) => {
  const d = await deps(req, true);
  if (d instanceof NextResponse) return d;
  const q = new URL(req.url).searchParams;
  // The recorder's check before it sends anything (asked at an utterance, never by a timer).
  if (q.get("status") === "1") {
    const days = (await readConfig())["recordings.retentionDays"];
    return answer({ status: 200, json: { on: true, retentionDays: days } });
  }
  const clip = q.get("clip");
  if (clip !== null) {
    const r = await clipAudio(d, clip);
    if ("status" in r) return answer(r);
    return new Response(r.wav as Uint8Array<ArrayBuffer>, {
      headers: {
        ...NO_STORE,
        "content-type": "audio/wav",
        "content-length": String(r.wav.length),
        "content-disposition": `inline; filename="${r.meta.id}.wav"`,
      },
    });
  }
  const day = q.get("day");
  if (day !== null && q.get("archive") === "zip") {
    const tz = Number(q.get("tz") ?? 0);
    const r = await dayArchive(d, day, tz);
    if (!(r instanceof ReadableStream)) return answer(r);
    return new Response(r, {
      headers: {
        ...NO_STORE,
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="lianki-recordings-${day}.zip"`,
      },
    });
  }
  if (day !== null) return answer(await getDay(d, day));
  return answer(await listDays(d, q));
};

export const POST = async (req: Request) => {
  const d = await deps(req, false);
  if (d instanceof NextResponse) return d;
  // Refuse an oversized body before reading it (a missing length is read, then checked whole).
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_POST_BODY) return answer({ status: 413, json: { error: "too-large" } });
  const text = await req.text();
  if (text.length > MAX_POST_BODY) return answer({ status: 413, json: { error: "too-large" } });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return answer(await postRecording(d, parsed));
};

export const DELETE = async (req: Request) => {
  const d = await deps(req, false);
  if (d instanceof NextResponse) return d;
  const q = new URL(req.url).searchParams;
  const clip = q.get("clip");
  const day = q.get("day");
  if (clip !== null && day === null) return answer(await deleteClip(d, clip));
  if (day !== null && clip === null) return answer(await deleteDay(d, day));
  return answer({ status: 400, json: { error: "bad-query" } });
};
