/**
 * A short-lived URL that plays one of the user's own audio files (`say --play
 * file:<id>`; docs/li-sound-hub.md, "Playing audio from an agent").
 *
 * - `POST /api/my/files/<id>/play` (the user's own session, same origin, the
 *   My Files gate and the flag `chat.play-audio`): for an audio file of theirs,
 *   `{url}` = `/api/my/files/<id>/play?exp=<ms>&sig=<hmac>`, valid PLAY_URL_MS.
 * - `GET` that URL: the file, inline, with byte ranges (iOS asks for ranges
 *   while it plays), to whoever holds the URL until it expires. The signature
 *   binds the file, its owner and the expiry (HMAC, a key derived from
 *   AUTH_SECRET with its own label). Anything else: 404.
 *
 * Only audio (and audio-bearing webm/mp4) is served this way; any other file
 * stays an attachment at /api/my/files/<id>. Nothing here fetches a URL.
 */
import { type InboxDeps } from "@/lib/inbox/handlers";
import { isInboxId } from "@/lib/inbox/keys";
import { getItem } from "@/lib/inbox/store";
import { sameOriginWrite } from "@/lib/security/same-origin";

/** How long a minted URL plays: long enough for a long file's range requests. */
export const PLAY_URL_MS = 60 * 60_000;

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => Response.json({ error: "not-found" }, { status: 404, headers: NO_STORE });

function playKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("play-url: AUTH_SECRET missing or short");
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("lianki/play"),
          info: enc.encode("lianki/play/file/v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const payload = (owner: string, id: string, exp: number) => `p1|${owner}|${id}|${exp}`;

export async function signPlay(secret: string | undefined, owner: string, id: string, exp: number) {
  return hex(
    await crypto.subtle.sign("HMAC", await playKey(secret), enc.encode(payload(owner, id, exp))),
  );
}

export async function verifyPlay(
  secret: string | undefined,
  owner: string,
  id: string,
  exp: number,
  sig: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  return crypto.subtle.verify(
    "HMAC",
    await playKey(secret),
    unhex(sig),
    enc.encode(payload(owner, id, exp)),
  );
}

/** A type the page's <audio> element plays. */
export const isPlayable = (type: string) =>
  type.startsWith("audio/") || type === "video/webm" || type === "video/mp4";

export type PlayUrlDeps = InboxDeps & {
  /** The My Files gate and the flag chat.play-audio, for this signed-in user. */
  on: (who: { id: string; email: string }) => Promise<boolean>;
  secret: () => string | undefined;
};

/** POST /api/my/files/<id>/play — a short-lived URL for one of the user's own audio files. */
export async function mintPlayUrl(req: Request, id: string, d: PlayUrlDeps): Promise<Response> {
  if (!sameOriginWrite(req))
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const who = await d.who();
  if (!who?.id) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!isInboxId(id) || !(await d.on(who))) return notFound();
  const it = await getItem(d.db(), id);
  if (!it || it.ownerId !== who.id || !isPlayable(it.type)) return notFound();
  const exp = (d.now ?? Date.now)() + PLAY_URL_MS;
  const sig = await signPlay(d.secret(), who.id, id, exp);
  return Response.json(
    { url: `/api/my/files/${id}/play?exp=${exp}&sig=${sig}`, type: it.type, expiresAt: exp },
    { headers: NO_STORE },
  );
}

type RangeBucket = {
  get(
    key: string,
    opts?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array> } | null>;
};

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` within `size`; null when absent or not satisfiable. */
export function byteRange(
  h: string | null,
  size: number,
): { start: number; end: number } | null | "bad" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return "bad";
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "bad";
  return { start, end };
}

/** GET /api/my/files/<id>/play?exp&sig — the file while the URL is valid, with byte ranges. */
export async function servePlay(req: Request, id: string, d: PlayUrlDeps): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const exp = Number(q.get("exp"));
  const sig = q.get("sig") ?? "";
  const now = (d.now ?? Date.now)();
  if (!isInboxId(id) || !Number.isSafeInteger(exp) || exp <= now || exp > now + PLAY_URL_MS)
    return notFound();
  const it = await getItem(d.db(), id);
  if (!it || !isPlayable(it.type)) return notFound();
  if (!(await verifyPlay(d.secret(), it.ownerId, id, exp, sig))) return notFound();
  const range = byteRange(req.headers.get("range"), it.size);
  const base = {
    "content-type": it.type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "cache-control": "private, max-age=300",
    "content-disposition": "inline",
  };
  if (range === "bad")
    return new Response(null, {
      status: 416,
      headers: { ...base, "content-range": `bytes */${it.size}` },
    });
  const bucket = d.bucket() as unknown as RangeBucket;
  const obj = range
    ? await bucket.get(it.r2Key, {
        range: { offset: range.start, length: range.end - range.start + 1 },
      })
    : await bucket.get(it.r2Key);
  if (!obj) return notFound();
  if (!range)
    return new Response(obj.body, { headers: { ...base, "content-length": String(it.size) } });
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...base,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${it.size}`,
    },
  });
}
