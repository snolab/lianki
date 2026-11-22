/** PCM duplex v1: local capability validation and destination-specific mixing. No device access. */
export type LivePcmFormat = { sampleRate: 16000 | 48000; channels: 1 | 2; format: "s16le" };
export type LiveTicket = {
  version: 1;
  url: string;
  capability: string;
  expiresAt: number;
  clientOrigin: string;
  sourceId: string;
  destinationId: string;
  input: LivePcmFormat;
  output: LivePcmFormat;
  frameMs: 20;
  maxFrameBytes: number;
  inputWindowBytes: number;
};
export const LIVE_FRAME_MS = 20;
export const liveFrameSamples = (f: LivePcmFormat) => f.sampleRate / 50;
export const liveFrameBytes = (f: LivePcmFormat) => liveFrameSamples(f) * f.channels * 2;
const fail = (): never => {
  throw Error("live-audio-invalid-control");
};
export function liveFormat(raw: unknown): LivePcmFormat {
  const r = raw as Partial<LivePcmFormat> | null;
  if (
    !r ||
    (r.sampleRate !== 16000 && r.sampleRate !== 48000) ||
    (r.channels !== 1 && r.channels !== 2) ||
    r.format !== "s16le"
  )
    return fail();
  return { sampleRate: r.sampleRate, channels: r.channels, format: "s16le" };
}
export const liveId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
/** The file stays in this browser. The gateway additionally verifies the actual WS Origin. */
export function liveTicket(raw: unknown, origin: string, now = Date.now()): LiveTicket {
  const client = new URL(origin);
  if (
    client.origin !== origin ||
    !(
      client.protocol === "https:" ||
      (client.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(client.hostname))
    )
  )
    return fail();
  const r = raw as Partial<LiveTicket> | null;
  if (
    !r ||
    r.version !== 1 ||
    r.clientOrigin !== origin ||
    typeof r.url !== "string" ||
    typeof r.capability !== "string" ||
    r.capability.length < 16 ||
    r.capability.length > 1024 ||
    /[\s\u0000-\u001f\u007f]/.test(r.capability) ||
    !Number.isFinite(r.expiresAt) ||
    r.expiresAt! <= now ||
    !liveId(r.sourceId) ||
    !liveId(r.destinationId) ||
    r.sourceId === r.destinationId ||
    r.frameMs !== 20
  )
    return fail();
  const url = new URL(r.url);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/stream" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return fail();
  const input = liveFormat(r.input),
    output = liveFormat(r.output);
  const bytes = liveFrameBytes(input);
  if (
    input.sampleRate !== output.sampleRate ||
    input.channels !== output.channels ||
    r.maxFrameBytes !== bytes ||
    r.inputWindowBytes !== bytes * 8
  )
    return fail();
  return {
    version: 1,
    url: r.url,
    capability: r.capability,
    expiresAt: r.expiresAt!,
    clientOrigin: origin,
    sourceId: r.sourceId,
    destinationId: r.destinationId,
    input,
    output,
    frameMs: 20,
    maxFrameBytes: bytes,
    inputWindowBytes: bytes * 8,
  };
}
/** Internal bus aliases never shadow the explicit participants from a ticket. */
export function liveAliases(ticket: Pick<LiveTicket, "sourceId" | "destinationId">) {
  const used = new Set([ticket.sourceId, ticket.destinationId]);
  const reserve = (base: string) => {
    let id = base;
    while (used.has(id)) id += "_";
    used.add(id);
    return id;
  };
  return {
    a: reserve("synthetic-a"),
    b: reserve("synthetic-b"),
    returned: reserve("remote-return"),
  };
}
export type LiveSourceFrame = {
  id: string;
  /** Original participant, retained even when a source is forwarded under another name. */
  origin: string;
  format: LivePcmFormat;
  samples: Float32Array;
};
export type LiveRoute = { sourceId: string; destinationId: string; gain: number };
/** Separate logical destination mix; no physical speaker ownership, device opening or output recapture. */
export function mixLiveFrame(
  destinationId: string,
  format: LivePcmFormat,
  routes: readonly LiveRoute[],
  sources: readonly LiveSourceFrame[],
  maxGain: number,
): { samples: Float32Array; contributors: string[]; clipped: number } {
  if (!liveId(destinationId) || !Number.isFinite(maxGain) || maxGain < 0) return fail();
  liveFormat(format);
  const frames = liveFrameSamples(format);
  const sums = new Float64Array(frames * format.channels);
  const contributors: string[] = [],
    used = new Set<string>();
  for (const route of routes) {
    if (route.destinationId !== destinationId) continue;
    if (
      !liveId(route.sourceId) ||
      route.sourceId === destinationId ||
      used.has(route.sourceId) ||
      !Number.isFinite(route.gain) ||
      route.gain < 0 ||
      route.gain > maxGain
    )
      return fail();
    used.add(route.sourceId);
    const source = sources.find((s) => s.id === route.sourceId);
    if (!source) continue;
    if (!liveId(source.origin)) return fail();
    // Mix-minus follows provenance, not the alias used by a forwarded source.
    if (source.origin === destinationId) continue;
    const from = liveFormat(source.format);
    const sourceFrames = liveFrameSamples(from);
    if (
      source.samples.length !== sourceFrames * from.channels ||
      source.samples.some((x) => !Number.isFinite(x))
    )
      return fail();
    if (!route.gain) continue;
    contributors.push(source.id);
    for (let i = 0; i < frames; i++) {
      const at = (i * sourceFrames) / frames;
      const left = Math.floor(at),
        right = Math.min(left + 1, sourceFrames - 1),
        fraction = at - left;
      for (let channel = 0; channel < format.channels; channel++) {
        let value = 0;
        for (let sc = 0; sc < from.channels; sc++) {
          if (format.channels === 2 && from.channels === 2 && channel !== sc) continue;
          const a = source.samples[left * from.channels + sc],
            b = source.samples[right * from.channels + sc];
          value += a + (b - a) * fraction;
        }
        if (format.channels === 1 && from.channels === 2) value /= 2;
        sums[i * format.channels + channel] += value * route.gain;
      }
    }
  }
  const samples = new Float32Array(sums.length);
  let clipped = 0;
  for (let i = 0; i < sums.length; i++) {
    if (sums[i] > 1 || sums[i] < -1) clipped++;
    samples[i] = Math.max(-1, Math.min(1, sums[i]));
  }
  return { samples, contributors, clipped };
}
export function encodeLivePcm(samples: Float32Array): ArrayBuffer {
  if (samples.some((x) => !Number.isFinite(x))) return fail();
  const buffer = new ArrayBuffer(samples.length * 2),
    view = new DataView(buffer);
  samples.forEach((v, i) =>
    view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true),
  );
  return buffer;
}
export function decodeLivePcm(buffer: ArrayBuffer): Float32Array {
  if (buffer.byteLength % 2) return fail();
  const view = new DataView(buffer),
    samples = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    const v = view.getInt16(i * 2, true);
    samples[i] = v / (v < 0 ? 32768 : 32767);
  }
  return samples;
}
