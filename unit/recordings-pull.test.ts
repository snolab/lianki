/**
 * scripts/dev/recordings-pull-lib.ts (docs/recordings.md, "On the Mac"): a
 * day pulled with a `recordings:read` token into a local folder, kept clips
 * not fetched again, and the optional re-transcription through the Mac's own
 * speech server (its socket protocol, faked here).
 */
import { describe, expect, it } from "bun:test";
import { encodeWav } from "@lianki/debug-chat/mic";
import {
  type PullFs,
  type WsLike,
  clipName,
  localSttClient,
  pullDay,
  retranscribe,
  transcriptTxt,
  wavPcm,
} from "@/scripts/dev/recordings-pull-lib";

const AT = Date.parse("2026-11-14T01:02:03Z");
const clips = [
  {
    id: "aaaaaaaaaaaaaaaa",
    day: "2026-11-14",
    at: AT,
    durationMs: 1000,
    mode: "active",
    source: "local",
    device: "iphone",
    speaker: "me",
    text: "hi",
  },
  {
    id: "bbbbbbbbbbbbbbbb",
    day: "2026-11-14",
    at: AT + 60_000,
    durationMs: 1000,
    mode: "passive",
    source: "none",
    device: "iphone",
    speaker: null,
    text: "",
  },
];

function memFs(): PullFs & { files: Map<string, string | Uint8Array>; dirs: string[] } {
  const files = new Map<string, string | Uint8Array>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    exists: async (p) => files.has(p),
    mkdir: async (p) => void dirs.push(p),
    write: async (p, d) => void files.set(p, d),
    read: async (p) => {
      const d = files.get(p);
      if (d === undefined) throw new Error("ENOENT");
      return typeof d === "string" ? new TextEncoder().encode(d) : d;
    },
  };
}

function api(o: { status?: number; failClip?: string } = {}) {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth });
    if (o.status) return new Response("nope", { status: o.status });
    const q = new URL(url).searchParams;
    if (q.get("day")) return Response.json({ day: q.get("day"), clips });
    if (q.get("clip") === o.failClip) return new Response("gone", { status: 410 });
    return new Response(encodeWav(new Float32Array(160)) as Uint8Array<ArrayBuffer>);
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("pullDay", () => {
  it("writes the transcripts and each clip, with the token, into <out>/<day>", async () => {
    const fs = memFs();
    const a = api();
    const logs: string[] = [];
    const r = await pullDay(
      {
        base: "https://lianki.test",
        token: "lk_x",
        fetch: a.f,
        fs,
        log: (l) => void logs.push(l),
        tzMin: -540,
      },
      "2026-11-14",
      "/out",
    );
    expect(r).toEqual({ dir: "/out/2026-11-14", clips: 2, fetched: 2, skipped: 0, failed: 0 });
    expect(a.seen.every((s) => s.auth === "Bearer lk_x")).toBe(true);
    expect(a.seen[0]!.url).toBe("https://lianki.test/api/my/recordings?day=2026-11-14");
    expect([...fs.files.keys()].sort()).toEqual([
      "/out/2026-11-14/100203-aaaaaaaaaaaaaaaa.wav",
      "/out/2026-11-14/100303-bbbbbbbbbbbbbbbb.wav",
      "/out/2026-11-14/transcript.json",
      "/out/2026-11-14/transcript.txt",
    ]);
    expect(fs.files.get("/out/2026-11-14/transcript.txt")).toBe("10:02:03 [me] hi\n10:03:03\n");
    expect(logs.at(-1)).toContain("2 fetched");
    // Again: nothing fetched twice.
    const again = await pullDay(
      { base: "https://lianki.test", token: "lk_x", fetch: a.f, fs, tzMin: -540 },
      "2026-11-14",
      "/out",
    );
    expect(again).toMatchObject({ fetched: 0, skipped: 2 });
  });

  it("a clip that fails is counted and logged; the rest still come", async () => {
    const fs = memFs();
    const logs: string[] = [];
    const r = await pullDay(
      {
        base: "https://b",
        token: "t",
        fetch: api({ failClip: "aaaaaaaaaaaaaaaa" }).f,
        fs,
        log: (l) => void logs.push(l),
      },
      "2026-11-14",
      "/o",
    );
    expect(r).toMatchObject({ fetched: 1, failed: 1 });
    expect(logs[0]).toContain("410");
  });

  it("refuses a bad day, explains a 404, passes other errors on", async () => {
    const d = { base: "https://b", token: "t", fs: memFs() };
    await expect(pullDay({ ...d, fetch: api().f }, "14-11-2026", "/o")).rejects.toThrow(
      "YYYY-MM-DD",
    );
    await expect(
      pullDay({ ...d, fetch: api({ status: 404 }).f }, "2026-11-14", "/o"),
    ).rejects.toThrow("recordings:read");
    await expect(
      pullDay({ ...d, fetch: api({ status: 503 }).f }, "2026-11-14", "/o"),
    ).rejects.toThrow("503 nope");
  });

  it("names and lines", () => {
    expect(clipName({ at: AT, id: "x" })).toBe("010203-x.wav");
    expect(transcriptTxt([{ at: AT, speaker: null, text: null }])).toBe("01:02:03 (unreadable)\n");
  });
});

describe("retranscribe", () => {
  it("writes each clip's local text and the day's, counting failures", async () => {
    const fs = memFs();
    await pullDay({ base: "https://b", token: "t", fetch: api().f, fs }, "2026-11-14", "/o");
    fs.files.delete("/o/2026-11-14/010303-bbbbbbbbbbbbbbbb.wav");
    const logs: string[] = [];
    let n = 0;
    const r = await retranscribe(
      fs,
      "/o/2026-11-14",
      async () => (n++ ? Promise.reject(new Error("x")) : "new text"),
      (l) => void logs.push(l),
    );
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(fs.files.get("/o/2026-11-14/010203-aaaaaaaaaaaaaaaa.local.txt")).toBe("new text\n");
    expect(fs.files.get("/o/2026-11-14/transcript.local.txt")).toBe(
      "01:02:03 [me] new text\n01:03:03 (unreadable)\n",
    );
    const bad = await retranscribe(fs, "/o/2026-11-14", async () => {
      throw new Error("down");
    });
    expect(bad).toEqual({ done: 0, failed: 1 });
    expect(logs.at(-1)).toContain("re-transcribed 1");
  });
});

/** A fake of the Mac's speech server over a socket. */
function fakeServer(o: { error?: boolean; noReady?: boolean; close?: boolean } = {}) {
  const sent: (string | Uint8Array)[] = [];
  let closed = false;
  const make = (): WsLike => {
    const ws: WsLike = {
      binaryType: "",
      send(d) {
        sent.push(d);
        if (typeof d !== "string") return;
        const m = JSON.parse(d);
        if (m.t !== "end") return;
        const reply = o.error
          ? { t: "error", id: m.id, error: "decode failed" }
          : { t: "final", id: m.id, text: `clip ${m.id}` };
        queueMicrotask(() => {
          ws.onmessage?.({ data: new Uint8Array(1) }); // binary: ignored
          ws.onmessage?.({ data: "not json" });
          ws.onmessage?.({ data: JSON.stringify({ t: "partial", id: m.id, text: "…" }) });
          ws.onmessage?.({ data: JSON.stringify({ t: "final", id: 999, text: "stray" }) });
          ws.onmessage?.({ data: JSON.stringify(reply) });
        });
      },
      close() {
        closed = true;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      if (o.close) return ws.onclose?.();
      if (!o.noReady) ws.onmessage?.({ data: JSON.stringify({ t: "ready", engine: "x" }) });
    });
    return ws;
  };
  return { make, sent, closed: () => closed };
}

describe("localSttClient: the Mac's speech server protocol", () => {
  const wav = encodeWav(new Float32Array(20_000).fill(0.5));

  it("begin, 0x01 PCM frames, end → the final's text; one socket for many clips", async () => {
    const s = fakeServer();
    let opens = 0;
    const c = localSttClient(() => (opens++, s.make()));
    expect(await c.stt(wav)).toBe("clip 1");
    expect(await c.stt(wav)).toBe("clip 2");
    expect(opens).toBe(1);
    const first = s.sent.slice(0, 4);
    expect(JSON.parse(first[0] as string)).toEqual({ t: "begin", id: 1 });
    expect((first[1] as Uint8Array)[0]).toBe(1);
    expect((first[1] as Uint8Array).length).toBe(1 + 16_000 * 2);
    expect((first[2] as Uint8Array).length).toBe(1 + 4_000 * 2);
    expect(JSON.parse(first[3] as string)).toEqual({ t: "end", id: 1 });
    c.close();
    expect(s.closed()).toBe(true);
  });

  it("an error answer, a closed socket, a timeout, a non-WAV", async () => {
    await expect(localSttClient(fakeServer({ error: true }).make).stt(wav)).rejects.toThrow(
      "decode failed",
    );
    await expect(localSttClient(fakeServer({ close: true }).make).stt(wav)).rejects.toThrow(
      "closed",
    );
    const quiet = fakeServer();
    const make = () => {
      const ws = quiet.make();
      const send = ws.send.bind(ws);
      ws.send = (d) => (typeof d === "string" && JSON.parse(d).t === "end" ? undefined : send(d));
      return ws;
    };
    await expect(localSttClient(make, 5).stt(wav)).rejects.toThrow("timed out");
    await expect(localSttClient(fakeServer().make).stt(new Uint8Array(10))).rejects.toThrow(
      "not a wav",
    );
    // A socket error rejects what waits, and the next call opens a new one.
    let ws: WsLike | null = null;
    const c = localSttClient(() => (ws = fakeServer({ noReady: true }).make()));
    const p = c.stt(wav);
    await Promise.resolve();
    ws!.onerror?.(new Error("x"));
    await expect(p).rejects.toThrow("not reachable");
  });

  it("wavPcm reads the data chunk past others", () => {
    const w = encodeWav(new Float32Array([0.5, -0.5]));
    expect(Array.from(wavPcm(w)!)).toEqual([16383, -16384]);
    const list = new Uint8Array(w.length + 12);
    list.set(w.subarray(0, 36));
    list.set(new TextEncoder().encode("LIST"), 36);
    new DataView(list.buffer).setUint32(40, 3, true); // odd size: padded
    list.set(w.subarray(36), 48);
    expect(Array.from(wavPcm(list)!)).toEqual([16383, -16384]);
    expect(wavPcm(new Uint8Array(50))).toBeNull();
    const noData = w.slice(0, 44);
    noData.set(new TextEncoder().encode("junk"), 36);
    expect(wavPcm(noData)).toBeNull();
  });
});
