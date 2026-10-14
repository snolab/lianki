/**
 * Serve the swipe-to-grade PoC (this folder) and, with --tunnel, expose it on a
 * Cloudflare quick tunnel so a phone can open it over https — the Vibration
 * API needs a secure context and a real touch device.
 *
 *   bun scripts/poc/swipe-grade/serve.ts --tunnel [--port 3004]
 *
 * Pages
 *   /              top page: vibrate button, clip controls, log, deck in an iframe
 *   /frame.html    playlist deck (whole videos)          ?v=<id>,<id>
 *   /clips.html    clip deck (≤ 60 s bites from captions) ?v=<ids>&q=<phrase>&lang=<code>
 *
 * API (clip source = YouTube's own caption tracks, fetched server-side)
 *   /api/transcript?v=<id>&lang=<code>       caption tracks + timed segments
 *   /api/clips?v=<ids>&q=<phrase>&lang=<code>&max=60   clip cards
 *   /api/filmot?q=<phrase>&lang=<code>       Filmot subtitle search (needs FILMOT_KEY; untested)
 */
import { bin as cloudflaredBin, install as installCloudflared } from "cloudflared";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const args = process.argv.slice(2);
const portArg = args[args.indexOf("--port") + 1];
const PORT = (args.includes("--port") && Number(portArg)) || 3004;
const TUNNEL = args.includes("--tunnel");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ── YouTube captions ──────────────────────────────────────────────────────

type Track = {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
};
type Seg = { start: number; dur: number; text: string };
type Transcript = {
  videoId: string;
  title: string;
  tracks: { lang: string; auto: boolean; name: string }[];
  lang: string | null;
  auto: boolean;
  segs: Seg[];
};

const transcripts = new Map<string, Promise<Transcript>>();

/**
 * Caption tracks via InnerTube's ANDROID client. The web watch page lists the
 * same tracks, but its timedtext URLs now answer with an empty 200 unless a
 * proof-of-origin token is attached (verified 2026-10-14); the Android client's
 * URLs do not need one. Same trick the transcript libraries use.
 */
async function fetchTranscript(videoId: string, lang: string): Promise<Transcript> {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
      "x-youtube-client-name": "3",
      "x-youtube-client-version": "20.10.38",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "20.10.38",
          androidSdkVersion: 30,
          hl: "en",
        },
      },
      videoId,
    }),
  });
  const j = (await res.json()) as {
    videoDetails?: { title?: string };
    playabilityStatus?: { status?: string; reason?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
  };
  const title = j.videoDetails?.title ?? videoId;
  if (j.playabilityStatus?.status && j.playabilityStatus.status !== "OK")
    throw new Error(`${j.playabilityStatus.status}: ${j.playabilityStatus.reason ?? ""}`);
  const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const list = tracks.map((t) => ({
    lang: t.languageCode,
    auto: t.kind === "asr",
    name: t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? t.languageCode,
  }));
  if (!tracks.length) return { videoId, title, tracks: [], lang: null, auto: false, segs: [] };
  const pick =
    tracks.find((t) => t.languageCode === lang && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode === lang) ??
    tracks[0];
  const u = new URL(pick.baseUrl);
  u.searchParams.set("fmt", "json3");
  const raw = await (await fetch(u, { headers: { "user-agent": UA } })).text();
  const segs: Seg[] = [];
  if (raw.startsWith("{")) {
    const json = JSON.parse(raw) as {
      events?: { tStartMs: number; dDurationMs?: number; segs?: { utf8: string }[] }[];
    };
    for (const e of json.events ?? []) {
      const text = (e.segs ?? [])
        .map((s) => s.utf8)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) segs.push({ start: e.tStartMs / 1000, dur: (e.dDurationMs ?? 0) / 1000, text });
    }
  } else {
    // srv3 XML: <p t="ms" d="ms">text</p>
    for (const m of raw.matchAll(/<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
      const text = m[3]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
      if (text) segs.push({ start: Number(m[1]) / 1000, dur: Number(m[2]) / 1000, text });
    }
  }
  return { videoId, title, tracks: list, lang: pick.languageCode, auto: pick.kind === "asr", segs };
}
const transcript = (v: string, lang: string) => {
  const key = `${v}:${lang}`;
  if (!transcripts.has(key))
    transcripts.set(
      key,
      fetchTranscript(v, lang).catch((e) => {
        transcripts.delete(key);
        throw e;
      }),
    );
  return transcripts.get(key)!;
};

// ── clips: ≤ `max` seconds, cut at caption gaps ───────────────────────────

type Clip = {
  videoId: string;
  title: string;
  lang: string | null;
  auto: boolean;
  start: number;
  end: number;
  text: string;
  hit: string | null;
};

function window(
  t: Transcript,
  from: number,
  max: number,
  minLen: number,
): { end: number; text: string } {
  const startSeg = from;
  let end = t.segs[startSeg].start + Math.max(t.segs[startSeg].dur, 1);
  const parts = [t.segs[startSeg].text];
  const base = t.segs[startSeg].start;
  for (let i = startSeg + 1; i < t.segs.length; i++) {
    const s = t.segs[i],
      prev = t.segs[i - 1];
    const gap = s.start - (prev.start + prev.dur);
    const len = s.start + Math.max(s.dur, 1) - base;
    if (len > max) break;
    if (end - base >= minLen && gap > 0.8) break; // sentence-ish boundary once we have enough
    end = s.start + Math.max(s.dur, 1);
    parts.push(s.text);
  }
  return { end: Math.min(end, base + max), text: parts.join(" ") };
}

function buildClips(t: Transcript, q: string, max: number, limit: number): Clip[] {
  const out: Clip[] = [];
  const pad = 1.0;
  const lead = 2.0;
  if (q) {
    const needle = q.toLowerCase();
    let lastEnd = -1;
    for (let i = 0; i < t.segs.length && out.length < limit; i++) {
      if (!t.segs[i].text.toLowerCase().includes(needle) || t.segs[i].start < lastEnd) continue;
      const w = window(t, i, max - lead, 12);
      const start = Math.max(0, t.segs[i].start - lead);
      out.push({
        videoId: t.videoId,
        title: t.title,
        lang: t.lang,
        auto: t.auto,
        start,
        end: Math.min(w.end + pad, start + max),
        text: w.text,
        hit: t.segs[i].text,
      });
      lastEnd = w.end;
    }
  } else {
    for (let i = 0; i < t.segs.length && out.length < limit; ) {
      const w = window(t, i, max, 15);
      const start = Math.max(0, t.segs[i].start - 0.5);
      out.push({
        videoId: t.videoId,
        title: t.title,
        lang: t.lang,
        auto: t.auto,
        start,
        end: Math.min(w.end + pad, start + max),
        text: w.text,
        hit: null,
      });
      let j = i + 1;
      while (j < t.segs.length && t.segs[j].start < w.end) j++;
      i = j;
    }
  }
  return out;
}

// ── Filmot (subtitle search across YouTube) — needs a key; shape per the
// public API docs (getsearchsubtitles), not exercised here ────────────────
async function filmot(q: string, lang: string): Promise<Response> {
  const key = process.env.FILMOT_KEY;
  if (!key)
    return Response.json(
      { error: "FILMOT_KEY is not set; Filmot search is off. Paste video ids instead." },
      { status: 501 },
    );
  const u = new URL("https://filmot.com/api/getsearchsubtitles");
  u.search = new URLSearchParams({ key, query: q, lang, searchManualSubs: "1" }).toString();
  const r = await fetch(u, { headers: { "user-agent": UA } });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}

// ── server ────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.searchParams;
    try {
      if (url.pathname === "/api/transcript") {
        const v = p.get("v") ?? "";
        if (!/^[\w-]{11}$/.test(v)) return json({ error: "v must be an 11-char video id" }, 400);
        const t = await transcript(v, p.get("lang") ?? "en");
        return json(t);
      }
      if (url.pathname === "/api/clips") {
        const ids = (p.get("v") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[\w-]{11}$/.test(s));
        if (!ids.length) return json({ error: "v must list 11-char video ids" }, 400);
        const q = (p.get("q") ?? "").trim();
        const lang = p.get("lang") ?? "en";
        const max = Math.min(60, Math.max(5, Number(p.get("max")) || 60));
        const per = Math.max(1, Number(p.get("per")) || 8);
        const videos: {
          videoId: string;
          title?: string;
          lang?: string | null;
          auto?: boolean;
          tracks?: unknown;
          clips?: number;
          error?: string;
        }[] = [];
        const clips: Clip[] = [];
        await Promise.all(
          ids.map(async (id) => {
            try {
              const t = await transcript(id, lang);
              const c = t.segs.length ? buildClips(t, q, max, per) : [];
              videos.push({
                videoId: id,
                title: t.title,
                lang: t.lang,
                auto: t.auto,
                tracks: t.tracks,
                clips: c.length,
              });
              clips.push(...c);
            } catch (e) {
              videos.push({ videoId: id, error: String(e) });
            }
          }),
        );
        // interleave videos so the deck does not play one source back to back
        clips.sort((a, b) => a.start - b.start);
        const byVideo = new Map<string, Clip[]>();
        for (const c of clips) byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]);
        const mixed: Clip[] = [];
        for (let i = 0; mixed.length < clips.length; i++)
          for (const list of byVideo.values()) if (list[i]) mixed.push(list[i]);
        return json({ q, lang, max, videos, clips: mixed });
      }
      if (url.pathname === "/api/filmot") return filmot(p.get("q") ?? "", p.get("lang") ?? "en");

      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(name)) return new Response("not found", { status: 404 });
      const file = Bun.file(join(DIR, name));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
});
console.log(`local:  http://localhost:${server.port}/`);

if (TUNNEL) {
  if (!existsSync(cloudflaredBin)) {
    console.log("downloading cloudflared (first run only)…");
    await installCloudflared(cloudflaredBin);
  }
  const proc = spawn(cloudflaredBin, ["tunnel", "--url", `http://localhost:${server.port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onChunk = (chunk: Buffer) => {
    const url = chunk.toString().match(/https:\/\/[-\w.]+\.trycloudflare\.com/)?.[0];
    if (url) console.log(`tunnel: ${url}/`);
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  const stop = () => {
    proc.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
