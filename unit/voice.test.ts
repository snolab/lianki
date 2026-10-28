import { describe, expect, test } from "bun:test";
import { voiceKey } from "@/lib/voice";

describe("voiceKey", () => {
  test("is the R2 key the offline renderer writes: voice/<lang>/<sha256>.mp3", () => {
    // Pinned: changing the hash input orphans every clip already in R2.
    expect(voiceKey("ja", "ひと")).toBe(
      `voice/ja/${new Bun.CryptoHasher("sha256").update("ja\nひと").digest("hex")}.mp3`,
    );
    expect(voiceKey("en", "the")).toMatch(/^voice\/en\/[0-9a-f]{64}\.mp3$/);
  });
  test("depends on the language and the exact text", () => {
    expect(voiceKey("zh", "的")).not.toBe(voiceKey("ja", "的"));
    expect(voiceKey("en", "The")).not.toBe(voiceKey("en", "the"));
  });
});
