import {
  type LocalStt,
  type WsLike,
  createLocalStt,
} from "../../packages/debug-chat/src/local-stt";

/** 16-bit PCM mono WAV → float samples (the clip sink's own format). */
export function readWav(buf: Uint8Array): { rate: number; samples: Float32Array } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 12;
  let rate = 16000;
  while (o + 8 <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") rate = v.getUint32(o + 12, true);
    if (id === "data") {
      const n = Math.min(size, buf.length - o - 8) >> 1;
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return { rate, samples: s };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** A LocalStt from Bun (Origin set as lianki.com's), resolved once the server says ready. */
export function connectLocalStt(url: string, timeoutMs = 5000): Promise<LocalStt> {
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`could not reach ${url}`)), timeoutMs);
    const stt = createLocalStt(url, {
      open: (u) =>
        new WebSocket(u, {
          headers: { origin: "https://lianki.com" },
        } as never) as unknown as WsLike,
      log: (ev) => {
        if (ev.state === "ready") {
          clearTimeout(give);
          resolve(stt);
        }
      },
    });
    stt.warm();
  });
}
