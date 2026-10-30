/**
 * Streaming speech-to-text on the owner's own Mac (docs/local-stt.md): while
 * he speaks, the mic's frames go over one WebSocket to scripts/local-stt
 * (SenseVoice), which answers partials as he talks and the final text the
 * moment the VAD ends the utterance. Owner pages only, behind
 * localStorage[LOCAL_STT_KEY] (a wss:// URL on the tailnet). Any failure —
 * not connected, a dropped socket, an error, no final in time — is a reject,
 * and the mic falls back to /api/debug/stt for that utterance, as before.
 * Nothing here polls: the socket is opened on the first utterance and again
 * on the next one after it closes.
 */

/** localStorage: the local STT server's WebSocket URL (owner pages only). */
export const LOCAL_STT_KEY = "lk:debug-local-stt";
/** No final within this long after the end: fall back. */
export const FINAL_TIMEOUT_MS = 4_000;
/** Connecting takes longer than this: this utterance goes the old way. */
export const CONNECT_TIMEOUT_MS = 2_500;

const TAG_FRAME = 1;
const TAG_PRE = 2;

/** The URL from localStorage, if it is one the owner's page may use (wss, or ws on localhost). */
export function localSttFrom(raw: string | null | undefined): string | undefined {
  let u: URL;
  try {
    u = new URL((raw ?? "").trim());
  } catch {
    return undefined;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && local)) return undefined;
  return u.href;
}

/** 16-bit little-endian PCM behind a one-byte tag. */
export function packPcm(tag: number, samples: Float32Array): Uint8Array {
  const out = new Uint8Array(1 + samples.length * 2);
  out[0] = tag;
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(1 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export type LocalFinal = {
  text: string;
  model: string;
  lang?: string;
  /** Decode time on the Mac. */
  ms: number;
  /** End of speech (the `end` sent) → final here, round trip included. */
  endToFinalMs: number;
  /** Utterance start → first partial shown, if any. */
  firstPartialMs?: number;
};

/** One utterance being streamed. */
export type LocalUtt = {
  frame(f: Float32Array): void;
  /** The whole utterance as the VAD cut it (its head, before the first frame, is sent as pre-pad). */
  end(audio: Float32Array): Promise<LocalFinal>;
  cancel(): void;
};

export type LocalStt = {
  /** Start an utterance; null when the socket isn't open (it is opened for next time). */
  begin(onPartial: (text: string) => void): LocalUtt | null;
  /** Open the socket now (on mic on), so the first utterance can stream. */
  warm(): void;
  close(): void;
  connected(): boolean;
};

/** The slice of WebSocket used (a fake in the tests). */
export type WsLike = {
  readyState: number;
  binaryType: string;
  send(d: string | Uint8Array): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
};

type Pending = {
  onPartial: (t: string) => void;
  resolve?: (f: LocalFinal) => void;
  reject?: (e: Error) => void;
  endAt?: number;
  began: number;
  firstPartialMs?: number;
  timer?: unknown;
};

export function createLocalStt(
  url: string,
  d: {
    open?: (url: string) => WsLike;
    now?: () => number;
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    log?: (ev: Record<string, unknown>) => void;
  } = {},
): LocalStt {
  const open = d.open ?? ((u) => new WebSocket(u) as unknown as WsLike);
  const now = d.now ?? (() => performance.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let ws: WsLike | null = null;
  let ready = false;
  let nextId = 1;
  let connectTimer: unknown;
  const utts = new Map<number, Pending>();

  const failAll = (why: string) => {
    for (const [id, p] of utts) {
      clearTimer(p.timer);
      p.reject?.(new Error(why));
      utts.delete(id);
    }
  };
  const connect = () => {
    if (ws) return;
    let s: WsLike;
    try {
      s = open(url);
    } catch (e) {
      d.log?.({ ev: "local-stt", state: "error", error: String(e).slice(0, 100) });
      return;
    }
    ws = s;
    s.binaryType = "arraybuffer";
    connectTimer = setTimer(() => {
      if (ws === s && !ready) s.close();
    }, CONNECT_TIMEOUT_MS);
    s.onopen = () => {};
    s.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m: {
        t?: string;
        id?: number;
        text?: string;
        model?: string;
        lang?: string;
        ms?: number;
        error?: string;
      };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "ready") {
        ready = true;
        clearTimer(connectTimer);
        d.log?.({ ev: "local-stt", state: "ready", model: m.model });
        return;
      }
      const p = m.id === undefined ? undefined : utts.get(m.id);
      if (!p) return;
      if (m.t === "partial" && typeof m.text === "string" && !p.resolve) {
        p.firstPartialMs ??= Math.round(now() - p.began);
        p.onPartial(m.text);
      } else if (m.t === "partial" && typeof m.text === "string") {
        // Already ended: only the final counts now.
      } else if (m.t === "final" && p.resolve) {
        clearTimer(p.timer);
        utts.delete(m.id as number);
        p.resolve({
          text: m.text ?? "",
          model: `local:${m.model ?? "?"}`,
          lang: m.lang,
          ms: m.ms ?? 0,
          endToFinalMs: Math.round(now() - (p.endAt ?? now())),
          firstPartialMs: p.firstPartialMs,
        });
      } else if (m.t === "error") {
        clearTimer(p.timer);
        utts.delete(m.id as number);
        p.reject?.(new Error(m.error ?? "local stt error"));
      }
    };
    s.onerror = () => {};
    s.onclose = () => {
      clearTimer(connectTimer);
      if (ws === s) {
        ws = null;
        if (ready) d.log?.({ ev: "local-stt", state: "closed" });
        ready = false;
      }
      failAll("local stt closed");
    };
  };
  const live = () => !!ws && ready && ws.readyState === 1;
  const send = (x: string | Uint8Array) => {
    try {
      ws?.send(x);
      return true;
    } catch {
      return false;
    }
  };

  return {
    connected: live,
    warm: connect,
    close() {
      const s = ws;
      ws = null;
      ready = false;
      s?.close();
      failAll("local stt closed");
    },
    begin(onPartial) {
      if (!live()) {
        connect();
        return null;
      }
      const id = nextId++;
      const p: Pending = { onPartial, began: now() };
      utts.set(id, p);
      send(JSON.stringify({ t: "begin", id }));
      let streamed = 0;
      let over = false;
      return {
        frame(f) {
          if (over || !live()) return;
          streamed += f.length;
          send(packPcm(TAG_FRAME, f));
        },
        end(audio) {
          over = true;
          return new Promise<LocalFinal>((resolve, reject) => {
            if (!live() || !utts.has(id)) {
              utts.delete(id);
              return reject(new Error("local stt not connected"));
            }
            p.resolve = resolve;
            p.reject = reject;
            // The VAD's pre-pad: the head of its audio that came before the first frame.
            const head = audio.length - streamed;
            if (head > 0) send(packPcm(TAG_PRE, audio.subarray(0, head)));
            p.endAt = now();
            send(JSON.stringify({ t: "end", id }));
            p.timer = setTimer(() => {
              if (!utts.has(id)) return;
              utts.delete(id);
              reject(new Error("local stt timed out"));
            }, FINAL_TIMEOUT_MS);
          });
        },
        cancel() {
          if (over) return;
          over = true;
          utts.delete(id);
          if (live()) send(JSON.stringify({ t: "cancel", id }));
        },
      };
    },
  };
}
