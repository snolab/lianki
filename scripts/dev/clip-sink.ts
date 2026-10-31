/**
 * The mic's clip sink on the owner's dev server (docs/dev-debug-widget.md,
 * "Voice clips"): with the owner's consent, each utterance his debug page
 * transcribes is also kept here, on this machine only — never in the repo,
 * never on the Worker — to build a test set for the STT bench.
 *
 *   POST /clips                 multipart: audio (file), meta (JSON) → {name}
 *   GET  /clips/index.json      every clip with its sidecar, and ref text if any
 *   GET  /clips/<name>.<ext>    one clip's audio
 *   POST /clips/bench?run=<id>  the bench's raw results, from the page (once per run)
 *
 * Cross-origin access is for https://lianki.com only. The folder is
 * LIANKI_CLIPS_DIR, else `lianki-voice-clips` in the home directory,
 * worked out at runtime.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIPS_ORIGIN = "https://lianki.com";
/** Largest clip accepted, in bytes. */
export const MAX_CLIP_BYTES = 5 * 1024 * 1024;

export const clipsDir = (env: Record<string, string | undefined> = process.env) =>
  env.LIANKI_CLIPS_DIR || join(homedir(), "lianki-voice-clips");

/** A clip's sidecar (<name>.json). */
export type ClipMeta = {
  at: string;
  mime: string;
  durationMs: number;
  label: string;
  transcript: string;
  model?: string;
  /**
   * What the browser applied to the mic track (voice-out.ts noteTrack /
   * appliedSettings), so AEC on and off can be told apart offline
   * (scripts/local-stt/ab-eval.py, docs/stt-ab.md).
   */
  track?: ClipTrack;
};
export type ClipTrack = {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
};
/** Only the known track fields, each of its own type; undefined when none is there. */
export function clipTrack(raw: unknown): ClipTrack | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, boolean | number> = {};
  for (const k of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const)
    if (typeof r[k] === "boolean") out[k] = r[k];
  for (const k of ["sampleRate", "channelCount"] as const)
    if (typeof r[k] === "number" && Number.isFinite(r[k])) out[k] = r[k];
  return Object.keys(out).length ? (out as ClipTrack) : undefined;
}
export type ClipEntry = ClipMeta & { name: string; file: string; ref?: string };

const EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  // Some encoders (and Bun, by file name) label audio-only WebM as video.
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
};
const NAME = /^[0-9TZ-]+-\d+$/;
const FILE = /^([0-9TZ-]+-\d+)\.(wav|webm|m4a|ogg|mp3)$/;
const RUN = /^[A-Za-z0-9-]{4,40}$/;

const cors = {
  "access-control-allow-origin": CLIPS_ORIGIN,
  vary: "Origin",
  "cache-control": "no-store",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { ...cors, "access-control-allow-private-network": "true" },
  });

let seq = 0;

/** The clip's name: its time (ISO, with ":" and "." made file-safe) and a sequence number. */
export const clipName = (at: Date, n: number) => `${at.toISOString().replace(/[:.]/g, "-")}-${n}`;

/** Every clip in `dir`, oldest first, with its sidecar and its `.ref.txt` if there is one. */
export function listClips(dir: string): ClipEntry[] {
  if (!existsSync(dir)) return [];
  const out: ClipEntry[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = FILE.exec(f);
    if (!m) continue;
    const name = m[1];
    let meta: Partial<ClipMeta> = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as ClipMeta;
    } catch {}
    const refPath = join(dir, `${name}.ref.txt`);
    out.push({
      name,
      file: f,
      at: meta.at ?? "",
      mime: meta.mime ?? "",
      durationMs: meta.durationMs ?? 0,
      label: meta.label ?? "",
      transcript: meta.transcript ?? "",
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.track ? { track: meta.track } : {}),
      ...(existsSync(refPath) ? { ref: readFileSync(refPath, "utf8").trim() } : {}),
    });
  }
  return out;
}

/** Answer a /clips request (or null if the path is not one). */
export async function handleClips(
  req: Request,
  dir: string,
  now: () => Date = () => new Date(),
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/clips/, "/clips");
  if (!path.startsWith("/clips")) return null;
  if (req.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
      },
    });
  const origin = req.headers.get("origin");
  if (origin && origin !== CLIPS_ORIGIN) return json({ error: "origin not allowed" }, 403);

  if (req.method === "POST" && path === "/clips") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "expected multipart audio + meta" }, 400);
    }
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) return json({ error: "no audio" }, 400);
    if (audio.size > MAX_CLIP_BYTES) return json({ error: "clip too large" }, 413);
    let meta: Partial<ClipMeta> = {};
    try {
      meta = JSON.parse(String(form.get("meta") ?? "{}")) as Partial<ClipMeta>;
    } catch {}
    const mime = (meta.mime || audio.type || "audio/wav").split(";")[0];
    const ext = EXT[mime];
    if (!ext) return json({ error: `unsupported type ${mime}` }, 415);
    const at = now();
    const name = clipName(at, seq++);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.${ext}`), new Uint8Array(await audio.arrayBuffer()));
    const side: ClipMeta = {
      at: typeof meta.at === "string" ? meta.at : at.toISOString(),
      mime,
      durationMs: Number(meta.durationMs) || 0,
      label: String(meta.label ?? "").slice(0, 300),
      transcript: String(meta.transcript ?? "").slice(0, 4000),
      ...(meta.model ? { model: String(meta.model).slice(0, 80) } : {}),
    };
    const track = clipTrack(meta.track);
    if (track) side.track = track;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(side, null, 2));
    return json({ name });
  }
  if (req.method === "POST" && path === "/clips/bench") {
    const run = url.searchParams.get("run") ?? "";
    if (!RUN.test(run)) return json({ error: "bad run id" }, 400);
    const file = join(dir, `bench-raw-${run}.json`);
    if (existsSync(file)) return json({ error: "already have this run" }, 409);
    const body = await req.text();
    try {
      JSON.parse(body);
    } catch {
      return json({ error: "not JSON" }, 400);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body);
    return json({ ok: true });
  }
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (path === "/clips/index.json") return json({ clips: listClips(dir) });
  const m = FILE.exec(path.slice("/clips/".length));
  if (!m || !NAME.test(m[1]) || !existsSync(join(dir, m[0])))
    return json({ error: "no such clip" }, 404);
  const type = Object.entries(EXT).find(([, e]) => e === m[2])?.[0] ?? "application/octet-stream";
  return new Response(readFileSync(join(dir, m[0])), {
    headers: { ...cors, "content-type": type, "access-control-allow-private-network": "true" },
  });
}
