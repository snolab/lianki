import { describe, expect, test } from "bun:test";
import { hasVoiceDetails, voiceDetailRows } from "../packages/debug-chat/src/voice-details";

describe("observed voice detail metadata", () => {
  test("a local recognizer identifies only its recorded speech server route and model", () => {
    expect(voiceDetailRows({ stt: { route: "local", engine: "sensevoice-small" } })).toEqual([
      { key: "route", value: "local" },
      { key: "recognitionModel", value: "sensevoice-small" },
    ]);
    expect(voiceDetailRows({ stt: { route: "local", fallback: true } })).toEqual([
      { key: "route", value: "local" },
    ]);
    expect(
      voiceDetailRows({
        stt: { route: "cloud", engine: "@cf/openai/whisper-large-v3-turbo", fallback: true },
      }),
    ).toEqual([
      { key: "route", value: "cloud" },
      { key: "recognitionModel", value: "@cf/openai/whisper-large-v3-turbo" },
      { key: "fallback", value: true },
    ]);
    expect(voiceDetailRows({ stt: { route: "cloud" } })).toEqual([
      { key: "route", value: "cloud" },
    ]);
    // The repetition guard cut a loop off the text (stt-repeat.ts).
    expect(voiceDetailRows({ stt: { route: "local", repeat: "trimmed" } })).toEqual([
      { key: "route", value: "local" },
      { key: "repeat", value: "trimmed" },
    ]);
  });

  test("speaker attribution keeps actual scores and uncertainty without exposing device or signed text", () => {
    const speaker = {
      decision: "unknown" as const,
      score: -0.1,
      model: "eres2netv2",
      reason: "noise",
      speechS: 0,
      snrDb: -3.5,
      device: "private-device",
      signed: ["private proof text"],
    };
    expect(voiceDetailRows({ speaker })).toEqual([
      { key: "speakerDecision", value: "unknown" },
      { key: "speakerScore", value: -0.1 },
      { key: "speakerModel", value: "eres2netv2" },
      { key: "speakerReason", value: "noise" },
      { key: "speakerSpeechS", value: 0 },
      { key: "speakerSnrDb", value: -3.5 },
    ]);
    expect(voiceDetailRows({ speaker: { decision: "me", voice: "me", score: 1 } })).toEqual([
      { key: "speakerDecision", value: "me" },
      { key: "speakerScore", value: 1 },
      { key: "speakerVoice", value: "me" },
    ]);
    expect(
      voiceDetailRows({ speaker: { decision: "other", voice: "s12", score: -1 } }).at(-1),
    ).toEqual({ key: "speakerVoice", value: "s12" });
  });

  test("recheck model and polish actor are distinct, with no invented polishing model or playback voice", () => {
    const metadata = {
      recheck: { engine: "whisper-large-v3", at: 200, heard: "raw", text: "rechecked", lang: "en" },
      edited: { by: "auto", at: 300, count: 2 },
    };
    const rows = voiceDetailRows(metadata);
    expect(rows).toEqual([
      { key: "recheckModel", value: "whisper-large-v3" },
      { key: "polishedBy", value: "auto" },
      { key: "polishedAt", value: 300 },
      { key: "polishCount", value: 2 },
    ]);
    rows[0]!.value = "caller mutation";
    expect(metadata.recheck.engine).toBe("whisper-large-v3");
    expect(voiceDetailRows({ from: "owner", source: "stt" })).toEqual([]);
    expect(voiceDetailRows({})).toEqual([]);
  });

  test("invalid or absent observations remain absent, preserving zero and negative valid measurements", () => {
    expect(
      voiceDetailRows({
        stt: { route: "phone", engine: "imagined" },
        speaker: { decision: "invented", model: "ignored" },
      } as never),
    ).toEqual([]);
    for (const score of [NaN, Infinity, -Infinity, -1.01, 1.01])
      expect(voiceDetailRows({ speaker: { decision: "unknown", score } })).toEqual([
        { key: "speakerDecision", value: "unknown" },
      ]);
    expect(
      voiceDetailRows({
        speaker: {
          decision: "unknown",
          voice: "device-name",
          reason: "unsupported",
          speechS: -1,
          snrDb: NaN,
        },
        edited: { by: " ", at: -1, count: 0 },
        stt: { route: "local", engine: "x".repeat(161) },
      }),
    ).toEqual([
      { key: "route", value: "local" },
      { key: "speakerDecision", value: "unknown" },
    ]);
    expect(voiceDetailRows({ edited: { by: "actor", at: 0, count: 1.5 } })).toEqual([
      { key: "polishedBy", value: "actor" },
      { key: "polishedAt", value: 0 },
    ]);
    expect(voiceDetailRows({ speaker: { decision: "me", score: 0, snrDb: 0 } })).toEqual([
      { key: "speakerDecision", value: "me" },
      { key: "speakerScore", value: 0 },
      { key: "speakerSnrDb", value: 0 },
    ]);
  });

  test("voice-detail affordance requires a voice input or recorded voice metadata", () => {
    expect(hasVoiceDetails({ from: "owner", source: "stt" })).toBe(true);
    expect(hasVoiceDetails({ from: "owner" })).toBe(false);
    expect(hasVoiceDetails({ from: "agent" })).toBe(false);
    expect(hasVoiceDetails({ from: "friend", source: "stt" })).toBe(false);
    expect(hasVoiceDetails({ stt: { route: "cloud" } })).toBe(true);
    expect(hasVoiceDetails({ speaker: { decision: "unknown" } })).toBe(true);
    expect(hasVoiceDetails({ timing: { audioMs: 100 } })).toBe(true);
    expect(hasVoiceDetails({ recheck: { engine: "recorded", at: 1, heard: "a", text: "b" } })).toBe(
      true,
    );
    expect(hasVoiceDetails({ edited: { at: 2, by: "editor", count: 1 } })).toBe(false);
  });
});
