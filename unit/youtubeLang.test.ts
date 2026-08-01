import { describe, expect, test, vi } from "vitest";
import { lookupYoutubeLanguages, youtubeVideoId } from "@lianki/core";

describe("youtubeVideoId", () => {
  test("extracts the id from a normalized watch url", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=ZKFq72VLLtA")).toBe("ZKFq72VLLtA");
  });

  test("ignores non-YouTube and malformed urls rather than guessing", () => {
    expect(youtubeVideoId("https://vimeo.com/watch?v=ZKFq72VLLtA")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=tooshort")).toBeNull();
    expect(youtubeVideoId("not a url")).toBeNull();
  });
});

const reply = (items: unknown[]) => ({ ok: true, status: 200, json: async () => ({ items }) });

describe("lookupYoutubeLanguages", () => {
  test("prefers the spoken language over the metadata language", async () => {
    // defaultLanguage describes the title/description — often the uploader's own
    // locale, not the audio. Labelling immersion hours from it would be wrong.
    const fetchImpl = vi.fn().mockResolvedValue(
      reply([
        {
          id: "aaaaaaaaaaa",
          snippet: { defaultAudioLanguage: "ja", defaultLanguage: "en", title: "T" },
        },
      ]),
    );
    const out = await lookupYoutubeLanguages(["aaaaaaaaaaa"], "key", fetchImpl as never);
    expect(out.get("aaaaaaaaaaa")).toEqual({ lang: "ja", title: "T" });
  });

  test("falls back to defaultLanguage only when audio is absent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(reply([{ id: "bbbbbbbbbbb", snippet: { defaultLanguage: "ko" } }]));
    expect(
      (await lookupYoutubeLanguages(["bbbbbbbbbbb"], "k", fetchImpl as never)).get("bbbbbbbbbbb"),
    ).toEqual({ lang: "ko", title: undefined });
  });

  test("reports no language rather than an empty string when neither is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply([{ id: "ccccccccccc", snippet: {} }]));
    expect(
      (await lookupYoutubeLanguages(["ccccccccccc"], "k", fetchImpl as never)).get("ccccccccccc")
        ?.lang,
    ).toBeUndefined();
  });

  test("batches at the API's 50-id cap and dedupes", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i).padStart(11, "x"));
    const fetchImpl = vi.fn().mockResolvedValue(reply([]));
    await lookupYoutubeLanguages([...ids, ...ids], "k", fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 120 unique → 50 + 50 + 20
  });

  test("skips the network entirely with no ids or no key", async () => {
    const fetchImpl = vi.fn();
    expect((await lookupYoutubeLanguages([], "k", fetchImpl as never)).size).toBe(0);
    expect((await lookupYoutubeLanguages(["aaaaaaaaaaa"], "", fetchImpl as never)).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("throws on an API error instead of silently labelling nothing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(lookupYoutubeLanguages(["aaaaaaaaaaa"], "k", fetchImpl as never)).rejects.toThrow(
      /403/,
    );
  });
});
