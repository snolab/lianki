import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  createMeetingEmbedding,
  MEETING_VOICE_MODEL_BYTES,
  MEETING_VOICE_MODEL_SHA256,
  type MeetingEmbeddingManifest,
  type MeetingEmbeddingProvider,
  type MeetingEmbeddingStatus,
} from "../lib/meeting-transcription/embedding";
import type { PcmFrame } from "../lib/meeting-transcription/contracts";

const ORIGIN = "http://127.0.0.1:3000";
function manifest(): MeetingEmbeddingManifest {
  return {
    model: {
      id: "campp-zh-en-fp32-v1",
      url: `${ORIGIN}/meeting-voice/campp.onnx`,
      bytes: MEETING_VOICE_MODEL_BYTES,
      sha256: MEETING_VOICE_MODEL_SHA256,
      precision: "fp32",
    },
    wasmBaseUrl: `${ORIGIN}/meeting-voice/ort/`,
    workerUrl: `${ORIGIN}/meeting-voice/meeting-voice-worker.js`,
  };
}
const frame = (): PcmFrame => ({
  track: "others",
  startSample: 0,
  samples: new Float32Array(32000).fill(0.1),
});
const signal = () => new AbortController().signal;
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

type Message = {
  id: number;
  kind: "warm" | "extract";
  consent?: boolean;
  options?: MeetingEmbeddingManifest;
  samples?: ArrayBuffer;
};
class FakeWorker extends EventTarget {
  messages: Message[] = [];
  terminated = 0;
  holdWarm = false;
  holdExtract = false;
  warmError: string | null = null;
  extractModel: string | null = null;
  invalidVector = false;
  postMessage(message: Message, transfer: Transferable[] = []) {
    const copied = structuredClone(message, { transfer });
    this.messages.push(copied);
    if (message.kind === "warm" && !this.holdWarm)
      queueMicrotask(() =>
        this.warmError
          ? this.reply(copied.id, { ok: false, error: this.warmError })
          : this.reply(copied.id, { ok: true }),
      );
    if (message.kind === "extract" && !this.holdExtract)
      queueMicrotask(() => {
        const embedding = new Float32Array(192);
        embedding[0] = this.invalidVector ? NaN : 1;
        this.reply(copied.id, {
          ok: true,
          result: {
            v: 1,
            trust: "device",
            model: this.extractModel ?? "campp-zh-en-fp32-v1",
            dimension: 192,
            audioMs: (copied.samples?.byteLength ?? 0) / 64,
            embedding,
          },
        });
      });
  }
  reply(id: number, result: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: { id, ...result } }));
  }
  terminate() {
    this.terminated++;
  }
}

const providers: MeetingEmbeddingProvider[] = [];
function setup(
  patch: Partial<Parameters<typeof createMeetingEmbedding>[0]> = {},
  customize?: (worker: FakeWorker) => void,
) {
  const workers: FakeWorker[] = [],
    statuses: MeetingEmbeddingStatus[] = [],
    urls: string[] = [];
  const provider = createMeetingEmbedding(
    {
      consent: true,
      manifest: manifest(),
      origin: ORIGIN,
      onStatus: (status) => statuses.push(status),
      ...patch,
    },
    {
      createWorker(url) {
        urls.push(url);
        const worker = new FakeWorker();
        customize?.(worker);
        workers.push(worker);
        return worker as unknown as Worker;
      },
    },
  );
  providers.push(provider);
  return { ...provider, workers, statuses, urls };
}
afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
});

describe("consent-gated device meeting embeddings", () => {
  it("does not create a worker or fetch until consent and the first embedding call", async () => {
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const h = setup();
      expect(h.workers).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
      const original = frame();
      const result = await h.embed(original, signal());
      expect(result).toBeInstanceOf(Float32Array);
      expect(result?.length).toBe(192);
      expect(result?.[0]).toBe(1);
      expect(h.workers).toHaveLength(1);
      expect(h.urls).toEqual([manifest().workerUrl]);
      expect(h.workers[0].messages.map((message) => message.kind)).toEqual(["warm", "extract"]);
      expect(h.workers[0].messages[0]).toMatchObject({
        consent: true,
        options: { model: manifest().model, wasmBaseUrl: manifest().wasmBaseUrl },
      });
      expect(original.samples.length).toBe(32000);
      expect(original.samples[0]).toBeCloseTo(0.1);
      expect(h.workers[0].messages[1].samples).not.toBe(original.samples.buffer);
      expect(h.statuses).toEqual(["ready"]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it("never starts work without explicit consent or a valid manifest", async () => {
    for (const patch of [{ consent: false }, { manifest: null }, { manifest: undefined }]) {
      const h = setup(patch);
      expect(await h.embed(frame(), signal())).toBeNull();
      expect(await h.embed(frame(), signal())).toBeNull();
      expect(h.workers).toHaveLength(0);
      expect(h.statuses).toEqual([
        patch.consent === false ? "consent-required" : "assets-unavailable",
      ]);
    }
  });

  it.each([
    { url: "https://foreign-cdn.example/campp.onnx" },
    { url: `${ORIGIN}/campp.onnx?token=private` },
    { url: `${ORIGIN}/campp.onnx#fragment` },
    {
      url: (() => {
        const value = new URL("/campp.onnx", ORIGIN);
        value.username = "fixture";
        value.password = "not-a-real-credential";
        return value.href;
      })(),
    },
    { bytes: MEETING_VOICE_MODEL_BYTES - 1 },
    { sha256: "0".repeat(64) },
    { precision: "int8" },
  ])("refuses unapproved model options without a worker: %j", async (patch) => {
    const value = manifest();
    Object.assign(value.model, patch);
    const h = setup({ manifest: value });
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(h.workers).toHaveLength(0);
    expect(h.statuses).toEqual(["assets-unavailable"]);
  });

  it.each([
    { workerUrl: "https://foreign-cdn.example/worker.js" },
    { workerUrl: `${ORIGIN}/worker.js?` },
    { workerUrl: "blob:http://127.0.0.1:3000/worker" },
    { wasmBaseUrl: "https://foreign-cdn.example/ort/" },
    { wasmBaseUrl: `${ORIGIN}/ort/#` },
  ])("refuses foreign or secret-bearing runtime/worker URLs: %j", async (patch) => {
    const h = setup({ manifest: { ...manifest(), ...patch } });
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(h.workers).toHaveLength(0);
  });

  it("warms once per run, copies manifest settings, and does not cache embeddings", async () => {
    const value = manifest(),
      h = setup({ manifest: value });
    value.model.url = "https://foreign-cdn.example/changed";
    await h.embed(frame(), signal());
    await h.embed(frame(), signal());
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].messages.map((message) => message.kind)).toEqual([
      "warm",
      "extract",
      "extract",
    ]);
    expect(h.workers[0].messages[0].options?.model.url).toBe(`${ORIGIN}/meeting-voice/campp.onnx`);
  });

  it("makes missing resources or warm failure sticky without repeated workers or remote fallback", async () => {
    const h = setup({}, (worker) => {
      worker.warmError = "artifact";
    });
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].messages).toHaveLength(1);
    expect(h.workers[0].terminated).toBe(1);
    expect(h.statuses).toEqual(["assets-unavailable"]);
  });

  it("turns worker construction exceptions into a fixed status without retrying", async () => {
    let calls = 0;
    const statuses: MeetingEmbeddingStatus[] = [];
    const provider = createMeetingEmbedding(
      {
        consent: true,
        manifest: manifest(),
        origin: ORIGIN,
        onStatus: (status) => statuses.push(status),
      },
      {
        createWorker() {
          calls++;
          throw new Error("private browser path");
        },
      },
    );
    providers.push(provider);
    expect(await provider.embed(frame(), signal())).toBeNull();
    expect(await provider.embed(frame(), signal())).toBeNull();
    expect(calls).toBe(1);
    expect(statuses).toEqual(["assets-unavailable"]);
  });

  it("rejects invalid PCM before warming any assets", async () => {
    const h = setup();
    for (const samples of [
      new Float32Array(100),
      new Float32Array(32000).fill(NaN),
      new Float32Array(32000).fill(2),
    ])
      expect(await h.embed({ ...frame(), samples }, signal())).toBeNull();
    expect(h.workers).toHaveLength(0);
    expect(h.statuses).toEqual(["audio-invalid"]);
  });

  it("treats invalid or mismatched device vectors as unknown and retires the worker", async () => {
    for (const mode of ["invalid", "model"] as const) {
      const h = setup({}, (worker) => {
        if (mode === "invalid") worker.invalidVector = true;
        else worker.extractModel = "another-model";
      });
      expect(await h.embed(frame(), signal())).toBeNull();
      expect(await h.embed(frame(), signal())).toBeNull();
      expect(h.workers).toHaveLength(1);
      expect(h.workers[0].terminated).toBe(1);
      expect(h.statuses).toEqual(["embedding-unavailable"]);
    }
  });

  it("closes pending warm immediately and permits a fresh generation only after the run reset", async () => {
    const h = setup({}, (worker) => {
      worker.holdWarm = true;
    });
    const first = h.embed(frame(), signal());
    await flush();
    h.close();
    expect(await first).toBeNull();
    expect(h.workers[0].terminated).toBe(1);
    h.workers[0].reply(1, { ok: true });
    await flush();
    expect(h.statuses).toEqual(["closed"]);
    const second = h.embed(frame(), signal());
    await flush();
    expect(h.workers).toHaveLength(2);
    h.workers[1].holdWarm = false;
    h.workers[1].reply(1, { ok: true });
    expect((await second)?.length).toBe(192);
    expect(h.statuses).toEqual(["closed", "ready"]);
  });

  it("aborts and terminates a pending extraction, ignores late results, and leaves caller PCM intact", async () => {
    const h = setup({}, (worker) => {
      worker.holdExtract = true;
    });
    const original = frame(),
      controller = new AbortController();
    const pending = h.embed(original, controller.signal);
    await flush();
    controller.abort();
    expect(await pending).toBeNull();
    expect(h.workers[0].terminated).toBe(1);
    const embedding = new Float32Array(192);
    embedding[0] = 1;
    h.workers[0].reply(2, {
      ok: true,
      result: {
        v: 1,
        trust: "device",
        model: manifest().model.id,
        dimension: 192,
        audioMs: 2000,
        embedding,
      },
    });
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(h.workers).toHaveLength(1);
    expect(h.statuses).toEqual(["aborted"]);
    expect(original.samples[0]).toBeCloseTo(0.1);
  });

  it("close clears failure state for a later explicitly started run and fences an old generation", async () => {
    const h = setup({}, (worker) => {
      worker.warmError = "unavailable";
    });
    expect(await h.embed(frame(), signal())).toBeNull();
    h.close();
    const second = h.embed(frame(), signal());
    h.workers[1].warmError = null;
    // The queued warm result may already be a failure; another explicit reset is allowed.
    expect((await second)?.length).toBe(192);
    expect(h.workers).toHaveLength(2);
  });

  it("does not create an already-aborted request or overlapping work", async () => {
    const h = setup({}, (worker) => {
      worker.holdWarm = true;
    });
    const controller = new AbortController();
    controller.abort();
    expect(await h.embed(frame(), controller.signal)).toBeNull();
    expect(h.workers).toHaveLength(0);
    const first = h.embed(frame(), signal());
    await flush();
    expect(await h.embed(frame(), signal())).toBeNull();
    expect(h.workers).toHaveLength(1);
    h.close();
    expect(await first).toBeNull();
  });

  it("does not return an embedding if a status callback stops the run", async () => {
    let provider!: MeetingEmbeddingProvider;
    const worker = new FakeWorker();
    provider = createMeetingEmbedding(
      {
        consent: true,
        manifest: manifest(),
        origin: ORIGIN,
        onStatus(status) {
          if (status === "ready") provider.close();
        },
      },
      { createWorker: () => worker as unknown as Worker },
    );
    providers.push(provider);
    expect(await provider.embed(frame(), signal())).toBeNull();
    expect(worker.terminated).toBe(1);
  });

  it("terminates a worker created during an abort without sending warm or audio", async () => {
    const controller = new AbortController(),
      worker = new FakeWorker();
    const provider = createMeetingEmbedding(
      { consent: true, manifest: manifest(), origin: ORIGIN },
      {
        createWorker() {
          controller.abort();
          return worker as unknown as Worker;
        },
      },
    );
    providers.push(provider);
    expect(await provider.embed(frame(), controller.signal)).toBeNull();
    expect(worker.messages).toEqual([]);
    expect(worker.terminated).toBe(1);
  });
});
