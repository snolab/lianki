import { afterEach, describe, expect, it } from "bun:test";
import { setPublicConfig } from "../lib/config-client";
import { CONFIG, parseConfigValue } from "../lib/config";
import { createConfiguredMeetingTranscription } from "../lib/meeting-transcription/configured";
import {
  MEETING_VOICE_MODEL_BYTES,
  MEETING_VOICE_MODEL_SHA256,
} from "../lib/meeting-transcription/embedding";

afterEach(() => setPublicConfig({}));
const options = {
  meetingId: "meeting_test",
  speakerConsent: false,
  origin: "https://app.example.test",
  onDraft: () => {},
  onStatus: () => {},
};
const deps = () => {
  const seen: any = {};
  return {
    seen,
    browser: async (o: any) => {
      seen.browser = o;
      return {} as any;
    },
    stt: (o: any) => {
      seen.stt = o;
      return Object.assign(async () => [], {
        close: () => {
          seen.sttClosed = true;
        },
      });
    },
    embedding: (o: any) => {
      seen.embedding = o;
      return {
        embed: async () => null,
        close: () => {
          seen.embeddingClosed = true;
        },
      };
    },
  };
};
describe("meeting transcription live configuration", () => {
  it("reads live window and admission limits, keeps missing model unknown and explicit consent unchanged", async () => {
    const cfg = structuredClone(CONFIG["meetings.transcription"].default);
    cfg.live.windowMs = 8000;
    cfg.final.windowMs = 9000;
    cfg.limits.maxFrameSamples = 8000;
    setPublicConfig({ "meetings.transcription": cfg });
    const d = deps(),
      r = await createConfiguredMeetingTranscription(options, d);
    expect(d.seen.stt).toEqual({
      route: "rtc:lianki",
      maxSamples: 144000,
      connectionReuseMs: 30000,
    });
    expect(d.seen.browser.limits.maxFrameSamples).toBe(8000);
    expect(d.seen.browser.live.windowMs).toBe(8000);
    expect(d.seen.embedding.consent).toBe(false);
    expect(d.seen.embedding.manifest).toBeNull();
    expect(r.voiceprintConfigured).toBe(false);
    d.seen.browser.embed.close();
    expect(d.seen.embeddingClosed).toBe(true);
  });
  it("passes only explicitly configured model metadata and the per-meeting consent", async () => {
    const manifest = {
      workerUrl: "https://app.example.test/meeting-voice/worker.js",
      wasmBaseUrl: "https://app.example.test/meeting-voice/ort/",
      model: {
        id: "campp-v1",
        url: "https://app.example.test/meeting-voice/model.onnx",
        bytes: MEETING_VOICE_MODEL_BYTES,
        sha256: MEETING_VOICE_MODEL_SHA256,
        precision: "fp32",
      },
    };
    setPublicConfig({ "meetings.voiceprintAssets": JSON.stringify(manifest) });
    const d = deps(),
      r = await createConfiguredMeetingTranscription({ ...options, speakerConsent: true }, d);
    expect(d.seen.embedding.manifest).toMatchObject(manifest);
    expect(d.seen.embedding.consent).toBe(true);
    expect(r.voiceprintConfigured).toBe(true);
  });
  it("treats invalid manifest JSON as unavailable and refuses a disabled route before creating providers", async () => {
    setPublicConfig({ "meetings.voiceprintAssets": "bad JSON" });
    const d = deps();
    expect((await createConfiguredMeetingTranscription(options, d)).voiceprintConfigured).toBe(
      false,
    );
    setPublicConfig({ "meetings.transcriptionRoute": "" });
    const off = deps();
    await expect(createConfiguredMeetingTranscription(options, off)).rejects.toMatchObject({
      code: "config",
    });
    expect(off.seen).toEqual({});
  });
  it("closes both providers if browser binding fails", async () => {
    const d = deps();
    d.browser = async () => {
      throw new Error("binding");
    };
    await expect(createConfiguredMeetingTranscription(options, d)).rejects.toThrow(
      /^Meeting transcription provider\.$/,
    );
    expect(d.seen.sttClosed).toBe(true);
    expect(d.seen.embeddingClosed).toBe(true);
  });
  it("rejects inconsistent windows, thresholds and protocol-overflow limits", () => {
    const check = (edit: (v: any) => void) => {
      const v = structuredClone(CONFIG["meetings.transcription"].default);
      edit(v);
      expect(parseConfigValue("meetings.transcription", v).ok).toBe(false);
    };
    check((v) => (v.live.overlapMs = v.live.windowMs));
    check((v) => (v.final.overlapMs = v.final.windowMs / 2));
    check((v) => (v.final.diarization.hopMs = 2500));
    check((v) => (v.final.diarization.ambiguityMargin = 0.9));
    check((v) => (v.limits.maxRowsPerWrite = 201));
    check((v) => (v.limits.maxFrameSamples = v.limits.maxQueuedSamplesPerTrack + 1));
  });
});
