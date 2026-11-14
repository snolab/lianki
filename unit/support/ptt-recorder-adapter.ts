import { expect, test } from "bun:test";

// Isolated process: every audio node is inert; no physical mic, sound or network.
let processor: { onaudioprocess: ((e: unknown) => void) | null } | undefined;
let stopped = 0;
let obtain: () => Promise<unknown>;
const stream = () => ({
  getTracks: () => [
    {
      stop: () => {
        stopped++;
      },
    },
  ],
  getAudioTracks: () => [{ readyState: "live" }],
});
class SilentContext {
  state = "running";
  sampleRate = 16000;
  destination = {};
  resume = async () => {};
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    processor = { onaudioprocess: null };
    return Object.assign(processor, { connect() {}, disconnect() {} });
  }
}
Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: SilentContext });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => obtain() } },
});
const { pttRecorder } = await import("../../packages/debug-chat/src/MicButton");
const { pttHolding } = await import("../../packages/debug-chat/src/ptt");
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("adapter cap stops fake capture immediately but holds ordinary VAD until pointer release", async () => {
  obtain = async () => stream();
  const failures: string[] = [];
  const rec = pttRecorder({
    maxCaptureMs: 1000,
    onFailure: (error) => failures.push(error.message),
  });
  rec.start(Date.now() - 2000);
  await settle();
  expect(pttHolding()).toBe(true);
  processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(16001) } });
  expect(failures).toEqual(["ptt-too-long"]);
  expect(stopped).toBe(1);
  expect(processor!.onaudioprocess).toBeNull();
  expect(pttHolding()).toBe(true);
  await expect(rec.finish(Date.now())).rejects.toThrow("ptt-too-long");
  expect(pttHolding()).toBe(false);
});

test("abort/account switch while permission is pending closes the late stream without starting PCM", async () => {
  let granted!: (value: unknown) => void;
  obtain = () =>
    new Promise((resolve) => {
      granted = resolve;
    });
  const before = stopped;
  const rec = pttRecorder();
  rec.start();
  rec.abort();
  expect(pttHolding()).toBe(false);
  granted(stream());
  await settle();
  expect(stopped).toBe(before + 1);
  expect(processor!.onaudioprocess).toBeNull();
  await expect(rec.finish()).rejects.toThrow("ptt-cancelled");
});
