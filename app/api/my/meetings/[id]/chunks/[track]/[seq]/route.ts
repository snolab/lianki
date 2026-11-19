import { MAX_CHUNK_BYTES, isTrack, parseChunkHeaders, parseSeq } from "@/lib/meetings/core";
import { NO_STORE, answer, meetingDeps } from "@/lib/meetings/gate";
import { bad, chunkBytes, putChunk } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; track: string; seq: string }> };

async function target(ctx: Ctx) {
  const p = await ctx.params;
  const seq = parseSeq(p.seq);
  if (!isTrack(p.track) || seq === null) return null;
  return { id: p.id, track: p.track, seq };
}

/**
 * One piece (docs/meetings.md, "The upload route"). PUT: raw bytes with
 * x-lk-sha256, x-lk-start-ms, x-lk-dur-ms, x-lk-frag-off, x-lk-frag-ms;
 * idempotent per (meeting, track, seq). GET: the piece, opened, with its
 * x-lk-start-ms / x-lk-dur-ms.
 */
export const PUT = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const t = await target(ctx);
  if (!t) return answer(bad(400, "bad piece"));
  const h = parseChunkHeaders(req.headers);
  if (typeof h === "string") return answer(bad(400, h));
  // Refused unread above the cap; a missing length is read, then checked.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_CHUNK_BYTES)
    return answer(bad(413, "too large"));
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_CHUNK_BYTES) return answer(bad(413, "too large"));
  return answer(await putChunk(d, t.id, t.track, t.seq, h, bytes));
};

export const GET = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const t = await target(ctx);
  if (!t) return answer(bad(400, "bad piece"));
  const r = await chunkBytes(d, t.id, t.track, t.seq);
  if ("status" in r) return answer(r);
  return new Response(r.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      ...NO_STORE,
      "content-type": r.mime,
      "content-length": String(r.bytes.length),
      "x-lk-start-ms": String(r.startMs),
      "x-lk-dur-ms": String(r.durMs),
      "x-content-type-options": "nosniff",
    },
  });
};
