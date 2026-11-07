import { describe, expect, it } from "bun:test";
import { VOICES_PROBE, voicesReport } from "@/scripts/dev/voices-list";
import { isLineVoiceId } from "@lianki/debug-chat/voices";

describe("eval.ts voices: the ids say --voice takes", () => {
  it("turns each page's voices into device ids (zh, ja, en first), plus the cloud list", () => {
    const r = voicesReport([
      {
        label: "/read iPhone",
        ok: true,
        value: {
          voices: [
            { name: "Samantha", lang: "en-US", voiceURI: "com.apple.voice.compact.en-US.Samantha" },
            { name: "Kyoko", lang: "ja-JP" },
            { name: "Meijia", lang: "zh-TW" },
            { name: "Albert", lang: "en-US", voiceURI: "com.apple.speech.synthesis.voice.Albert" },
            { nope: 1 },
          ],
        },
      },
      { label: "/words Mac", ok: false, error: "timeout" },
    ]);
    expect(r.type).toBe("voices");
    expect(r.pages[0]!.device!.map((v) => v.id)).toEqual([
      "device:Meijia",
      "device:Kyoko",
      "device:Samantha",
      "device:Albert",
    ]);
    expect(r.pages[0]!.device!.at(-1)!.tier).toBe("novelty");
    expect(r.pages[1]).toEqual({ label: "/words Mac", ok: false, error: "timeout" });
    for (const p of r.pages) for (const v of p.device ?? []) expect(isLineVoiceId(v.id)).toBe(true);
    expect(r.cloud.some((c) => c.id === "melo:ja")).toBe(true);
  });

  it("--cloud (no page asked): only the cloud list", () => {
    expect(voicesReport(null).pages).toEqual([]);
  });

  it("the probe only reads speechSynthesis: no speak, no setter", () => {
    expect(VOICES_PROBE).toContain("getVoices()");
    expect(VOICES_PROBE).not.toMatch(/\.speak\(|\.cancel\(|localStorage|fetch\(/);
  });
});
