/**
 * The logic of recordings-pull.ts (docs/recordings.md, "On the Mac"): fetch a
 * day of the account's mic recordings with an API token (`recordings:read`)
 * into a local folder, and optionally run each clip through the Mac's own
 * speech server (scripts/local-stt/server.py) for a new transcript. Nothing
 * leaves the Mac: the only network calls are to lianki.com (to read) and to
 * the local STT socket (127.0.0.1). Everything is injected, so it is tested.
 */

export type PulledClip = {
  id: string;
  day: string;
  at: number;
  durationMs: number;
  mode: string;
  source: string;
  device: string;
  speaker: string | null;
  text: string | null;
};

export type PullFs = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
};

/** Transcribe one WAV on the Mac (text, or throws). */
export type LocalStt = (wav: Uint8Array) => Promise<string>;

export type PullDeps = {
  base: string;
  token: string;
  fetch: typeof fetch;
  fs: PullFs;
  log?: (line: string) => void;
  /** The viewer's offset (Date.getTimezoneOffset), for file names. */
  tzMin?: number;
};

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A clip's file name: its local time of day and id (the same as the zip's, lib/recordings.ts clipName). */
export const clipName = (c: Pick<PulledClip, "at" | "id">, tzMin = 0) =>
  `${new Date(c.at - tzMin * 60_000).toISOString().slice(11, 19).replace(/:/g, "")}-${c.id}.wav`;

const hhmmss = (at: number, tzMin: number) =>
  new Date(at - tzMin * 60_000).toISOString().slice(11, 19);

/** "HH:MM:SS [speaker] text" per clip, as the zip's transcript.txt. */
export function transcriptTxt(
  clips: { at: number; speaker: string | null; text: string | null }[],
  tzMin = 0,
): string {
  return (
    clips
      .map((c) =>
        `${hhmmss(c.at, tzMin)}${c.speaker ? ` [${c.speaker}]` : ""} ${c.text ?? "(unreadable)"}`.trimEnd(),
      )
      .join("\n") + "\n"
  );
}

async function get(d: PullDeps, q: string): Promise<Response> {
  const r = await d.fetch(`${d.base}/api/my/recordings?${q}`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  if (r.status === 404)
    throw new Error(
      "404: the token needs recordings:read, the account the dev grant, and the flag voice.recordings must be on",
    );
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
  return r;
}

export type PullResult = {
  dir: string;
  clips: number;
  fetched: number;
  skipped: number;
  failed: number;
};

/** Pull one day into `<out>/<day>/`: transcript.json, transcript.txt, one WAV per clip (kept ones not fetched again). */
export async function pullDay(d: PullDeps, day: string, out: string): Promise<PullResult> {
  if (!DAY_RE.test(day)) throw new Error(`--day: YYYY-MM-DD, not ${day}`);
  const tz = d.tzMin ?? 0;
  const log = d.log ?? (() => {});
  const { clips } = (await (await get(d, `day=${day}`)).json()) as { clips: PulledClip[] };
  const dir = `${out}/${day}`;
  await d.fs.mkdir(dir);
  const withFiles = clips.map((c) => ({ ...c, file: clipName(c, tz) }));
  await d.fs.write(`${dir}/transcript.json`, JSON.stringify({ day, clips: withFiles }, null, 1));
  await d.fs.write(`${dir}/transcript.txt`, transcriptTxt(clips, tz));
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of withFiles) {
    const path = `${dir}/${c.file}`;
    if (await d.fs.exists(path)) {
      skipped++;
      continue;
    }
    try {
      const r = await get(d, `clip=${encodeURIComponent(c.id)}`);
      await d.fs.write(path, new Uint8Array(await r.arrayBuffer()));
      fetched++;
    } catch (e) {
      failed++;
      log(`clip ${c.id}: ${(e as Error).message}`);
    }
  }
  log(
    `${day}: ${clips.length} clip(s), ${fetched} fetched, ${skipped} already here, ${failed} failed → ${dir}`,
  );
  return { dir, clips: clips.length, fetched, skipped, failed };
}

/**
 * Transcribe every pulled clip of the day again on the Mac: `<clip>.local.txt`
 * beside each WAV, and transcript.local.txt / .json for the day. Local only.
 */
export async function retranscribe(
  fs: PullFs,
  dir: string,
  stt: LocalStt,
  log: (line: string) => void = () => {},
  tzMin = 0,
): Promise<{ done: number; failed: number }> {
  const meta = JSON.parse(new TextDecoder().decode(await fs.read(`${dir}/transcript.json`))) as {
    clips: (PulledClip & { file: string })[];
  };
  const out: {
    id: string;
    at: number;
    file: string;
    speaker: string | null;
    text: string | null;
  }[] = [];
  let done = 0;
  let failed = 0;
  for (const c of meta.clips) {
    const path = `${dir}/${c.file}`;
    let text: string | null = null;
    if (await fs.exists(path)) {
      try {
        text = await stt(await fs.read(path));
        await fs.write(`${path.replace(/\.wav$/, "")}.local.txt`, `${text}\n`);
        done++;
      } catch (e) {
        failed++;
        log(`stt ${c.file}: ${(e as Error).message}`);
      }
    }
    out.push({ id: c.id, at: c.at, file: c.file, speaker: c.speaker, text });
  }
  await fs.write(`${dir}/transcript.local.json`, JSON.stringify({ clips: out }, null, 1));
  await fs.write(`${dir}/transcript.local.txt`, transcriptTxt(out, tzMin));
  log(`re-transcribed ${done} clip(s) on this Mac${failed ? `, ${failed} failed` : ""}`);
  return { done, failed };
}

// ---------------------------------------------------------------- the Mac's speech server
/** The 16-bit PCM samples of a mono WAV (its `data` chunk), or null. */
export function wavPcm(b: Uint8Array): Int16Array | null {
  if (b.length < 44 || String.fromCharCode(...b.subarray(0, 4)) !== "RIFF") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "data") {
      const n = Math.min(size, b.length - o - 8) >> 1;
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(o + 8 + i * 2, true);
      return out;
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** What localSttClient needs of a WebSocket. */
export type WsLike = {
  binaryType: string;
  send(d: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: (() => void) | null;
};

/** Samples per binary frame sent (1 s at 16 kHz: far under the server's 4 MB frame limit). */
const FRAME = 16_000;

/**
 * A client for the Mac's speech server (docs/local-stt.md, "Protocol"): one
 * socket, utterances one after another — {t:"begin"}, 0x01 + int16 PCM
 * frames, {t:"end"} — and each {t:"final"} is that clip's text.
 */
export function localSttClient(
  open: () => WsLike,
  timeoutMs = 60_000,
): { stt: LocalStt; close(): void } {
  let ws: WsLike | null = null;
  let ready: Promise<void> | null = null;
  let seq = 0;
  const waiting = new Map<number, { ok: (t: string) => void; no: (e: Error) => void }>();
  const fail = (e: Error) => {
    for (const w of waiting.values()) w.no(e);
    waiting.clear();
    ws = null;
    ready = null;
  };
  const connect = () =>
    (ready ??= new Promise<void>((resolve, reject) => {
      const s = open();
      ws = s;
      s.binaryType = "arraybuffer";
      s.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        let m: { t?: string; id?: number; text?: string; error?: string };
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.t === "ready") return resolve();
        const w = typeof m.id === "number" ? waiting.get(m.id) : undefined;
        if (!w) return;
        if (m.t === "final") {
          waiting.delete(m.id!);
          w.ok(m.text ?? "");
        } else if (m.t === "error") {
          waiting.delete(m.id!);
          w.no(new Error(m.error ?? "stt error"));
        }
      };
      s.onerror = () => {
        reject(new Error("local STT not reachable"));
        fail(new Error("local STT socket error"));
      };
      s.onclose = () => {
        reject(new Error("local STT closed"));
        fail(new Error("local STT closed"));
      };
    }));
  const stt: LocalStt = async (wav) => {
    const pcm = wavPcm(wav);
    if (!pcm) throw new Error("not a wav");
    await connect();
    const s = ws!;
    const id = ++seq;
    const text = new Promise<string>((ok, no) => {
      waiting.set(id, { ok, no });
      setTimeout(() => {
        if (waiting.delete(id)) no(new Error("local STT timed out"));
      }, timeoutMs);
    });
    s.send(JSON.stringify({ t: "begin", id }));
    for (let i = 0; i < pcm.length; i += FRAME) {
      const part = pcm.subarray(i, i + FRAME);
      const frame = new Uint8Array(1 + part.length * 2);
      frame[0] = 0x01;
      frame.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), 1);
      s.send(frame);
    }
    s.send(JSON.stringify({ t: "end", id }));
    return text;
  };
  return {
    stt,
    close: () => {
      ws?.close();
      ws = null;
      ready = null;
    },
  };
}
