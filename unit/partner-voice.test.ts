import { describe, expect, test } from "bun:test";
import { standardVoiceSkip } from "../workers/push/src/partner-voice";

const conf = { needsName: true, liNames: ["Li", "学习伙伴"], continuation: false };
const speech = (text: string) => ({ source: "stt" as const, text });

describe("shared Partner speech intent", () => {
  test("an active microphone and short room audio cannot start a turn without voice identity", () => {
    for (const text of ["Yeah.", "그.", "hmm", "The room is noisy tonight."])
      expect(standardVoiceSkip(speech(text), conf)).toBe("unconfirmed-voice");
    expect(standardVoiceSkip(speech("Yeah."), { ...conf, needsName: false })).toBe(
      "unconfirmed-voice",
    );
  });

  test("unknown and other voices never bypass the gate through a name or continuation", () => {
    for (const decision of ["unknown", "other"] as const)
      for (const continuation of [false, true])
        expect(
          standardVoiceSkip(
            { ...speech("Li, help me plan"), speaker: { decision } },
            { ...conf, continuation, needsName: false },
          ),
        ).toBe("unconfirmed-voice");
  });

  test("a supplied but unverified proof never becomes an absent-identity device", () => {
    for (const continuation of [false, true])
      expect(
        standardVoiceSkip(speech("Li, help me plan"), {
          ...conf,
          continuation,
          unverifiedProof: true,
        }),
      ).toBe("unconfirmed-voice");
  });

  test("verified speech still needs an address unless the existing setting opts out", () => {
    const line = { ...speech("What should I study?"), speaker: { decision: "me" as const } };
    expect(standardVoiceSkip(line, conf)).toBe("spoken-unnamed");
    expect(standardVoiceSkip(line, { ...conf, needsName: false })).toBeNull();
    expect(standardVoiceSkip(line, { ...conf, continuation: true })).toBeNull();
  });

  test("an explicit assistant address works on devices without voiceprint support", () => {
    for (const text of ["Li, help me plan", "学习伙伴，帮我整理", "@coco fix the feature"])
      expect(standardVoiceSkip(speech(text), conf)).toBeNull();
    expect(
      standardVoiceSkip(speech("Buddy, help me plan"), { ...conf, liNames: ["Buddy"] }),
    ).toBeNull();
    expect(standardVoiceSkip(speech("like this room"), conf)).toBe("unconfirmed-voice");
  });

  test("continuations can complete the named request, and typing never needs a voiceprint", () => {
    expect(
      standardVoiceSkip(speech("and keep the original references"), {
        ...conf,
        continuation: true,
      }),
    ).toBeNull();
    expect(standardVoiceSkip({ text: "hello" }, conf)).toBeNull();
    expect(standardVoiceSkip({ text: "hello", speaker: { decision: "unknown" } }, conf)).toBeNull();
  });
});
