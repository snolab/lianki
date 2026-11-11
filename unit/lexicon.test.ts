import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_LEXICON,
  type LexEntry,
  activeLexicon,
  isLexEntry,
  setLexicon,
  speakForm,
  toSsml,
} from "@lianki/debug-chat/lexicon";
import { createVoice, type UtterLike } from "@lianki/debug-chat/voice";
import { CONFIG, parseConfigValue } from "@/lib/config";
import { draftValue, isStructured, valueText } from "@/app/(app)/dev/config/config-view";

const reset = () => delete (globalThis as { __lkLexicon?: unknown }).__lkLexicon;
afterEach(reset);

describe("speakForm: the seed table", () => {
  it("reads WebRTC as letters in every language, and leaves the rest alone", () => {
    expect(speakForm("WebRTC works", "en-US")).toBe("Web R T C works");
    expect(speakForm("用WebRTC连接手机", "zh-CN")).toBe("用Web R T C连接手机");
    expect(speakForm("Nothing to change here.", "en")).toBe("Nothing to change here.");
    expect(speakForm("", "en")).toBe("");
  });

  it("each seeded term has a spoken form", () => {
    const terms = new Set(DEFAULT_LEXICON.map((e) => e.term));
    for (const t of [
      "WebRTC",
      "API",
      "MCP",
      "Tailscale",
      "iOS",
      "PWA",
      "STT",
      "TTS",
      "URL",
      "JSON",
      "GitHub",
      "npm",
      "CLI",
      "Lianki",
    ])
      expect(terms.has(t)).toBe(true);
    for (const e of DEFAULT_LEXICON) expect(isLexEntry(e)).toBe(true);
  });

  it("the most specific language wins: a locale over its language over none", () => {
    expect(speakForm("iOS", "en-GB")).toBe("eye O S");
    expect(speakForm("iOS", "ja-JP")).toBe("アイオーエス");
    expect(speakForm("iOS", "zh-TW")).toBe("i O S");
    const t: LexEntry[] = [
      { term: "PWA", say: "any" },
      { term: "PWA", lang: "zh", say: "zh" },
      { term: "PWA", lang: "zh-TW", say: "tw" },
    ];
    expect(speakForm("PWA", "zh-TW", t)).toBe("tw");
    expect(speakForm("PWA", "zh_TW", t)).toBe("tw");
    expect(speakForm("PWA", "zh-CN", t)).toBe("zh");
    expect(speakForm("PWA", "zhx", t)).toBe("any");
    expect(speakForm("PWA", "fr", t)).toBe("any");
    // An entry only for another language does not apply.
    expect(speakForm("PWA", "fr", [{ term: "PWA", lang: "zh", say: "zh" }])).toBe("PWA");
  });
});

describe("speakForm: whole words and case", () => {
  it("never inside a longer word; punctuation and CJK are edges", () => {
    expect(speakForm("APIs and RAPID", "en")).toBe("APIs and RAPID");
    expect(speakForm("the API, the API.", "en")).toBe("the A P I, the A P I.");
    expect(speakForm("(API)", "en")).toBe("(A P I)");
    expect(speakForm("API_KEY", "en")).toBe("API_KEY");
    expect(speakForm("WebRTC-based", "en")).toBe("Web R T C-based");
    expect(speakForm("这个API很好", "zh")).toBe("这个A P I很好");
  });

  it("is case-sensitive unless the entry ignores case", () => {
    expect(speakForm("api and Api", "en")).toBe("api and Api");
    expect(speakForm("github GITHUB GitHub", "en")).toBe("Git Hub Git Hub Git Hub");
    expect(speakForm("NPM npm", "en")).toBe("N P M N P M");
  });

  it("a case-sensitive entry beats an ignore-case one for its exact spelling", () => {
    const t: LexEntry[] = [
      { term: "US", say: "U S" },
      { term: "us", say: "uhs", ignoreCase: true },
    ];
    expect(speakForm("US us Us", "en", t)).toBe("U S uhs uhs");
  });

  it("one pass, longest term first: a spoken form is never matched again", () => {
    const t: LexEntry[] = [
      { term: "AB", say: "A B" },
      { term: "A", say: "AB" },
      { term: "ABC", say: "x" },
    ];
    expect(speakForm("ABC AB A", "en", t)).toBe("x A B AB");
    // A term next to a rejected match is still found.
    expect(speakForm("XAB AB", "en", t)).toBe("XAB A B");
  });

  it("terms with regex characters are taken literally", () => {
    const t: LexEntry[] = [{ term: "C++", say: "C plus plus" }];
    expect(speakForm("C++ and C", "en", t)).toBe("C plus plus and C");
  });
});

describe("the live table (setLexicon)", () => {
  it("replaces the default with a valid table, kept on globalThis for every copy", () => {
    expect(activeLexicon()).toBe(DEFAULT_LEXICON);
    setLexicon([{ term: "WebRTC", say: "web real time" }]);
    expect(speakForm("WebRTC", "en")).toBe("web real time");
    expect((globalThis as { __lkLexicon?: unknown }).__lkLexicon).toEqual([
      { term: "WebRTC", say: "web real time" },
    ]);
  });

  it("anything invalid leaves the table as it was", () => {
    for (const bad of [
      null,
      "x",
      {},
      [{ term: "", say: "x" }],
      [{ term: "x", say: "" }],
      [{ term: "x", say: "y", lang: "Chinese" }],
      [{ term: "x", say: "y", ignoreCase: "yes" }],
      [{ term: "x", say: "y", ph: "" }],
      [{ term: "x", say: "y", alphabet: "arpabet" }],
      [[]],
      [null],
      Array.from({ length: 501 }, () => ({ term: "x", say: "y" })),
    ]) {
      setLexicon(bad);
      expect(activeLexicon()).toBe(DEFAULT_LEXICON);
    }
    expect(isLexEntry({ term: "x", say: "y", ph: "ɛks", alphabet: "ipa", lang: "en-US" })).toBe(
      true,
    );
  });
});

describe("toSsml (provider voices)", () => {
  it("escapes the text and writes each term as <sub alias> or <phoneme>", () => {
    const t: LexEntry[] = [
      { term: "WebRTC", say: "Web R T C" },
      { term: "Lianki", say: "Lian ki", ph: "ljɛn.ki" },
      { term: "X", say: 'a"b', ph: "eks", alphabet: "x-sampa" },
    ];
    expect(toSsml("WebRTC & <Lianki>", "en", t)).toBe(
      '<sub alias="Web R T C">WebRTC</sub> &amp; &lt;<phoneme alphabet="ipa" ph="ljɛn.ki">Lianki</phoneme>&gt;',
    );
    expect(toSsml("X's", "en", t)).toBe('<phoneme alphabet="x-sampa" ph="eks">X</phoneme>&apos;s');
    expect(toSsml('say "hi"', "en", [])).toBe("say &quot;hi&quot;");
  });
});

describe("config voice.lexicon", () => {
  it("its default is the seed and validates; the schema refuses what the page refuses", () => {
    expect(CONFIG["voice.lexicon"].default).toEqual([...DEFAULT_LEXICON]);
    expect(CONFIG["voice.lexicon"].audience).toBe("public");
    expect(parseConfigValue("voice.lexicon", DEFAULT_LEXICON).ok).toBe(true);
    expect(parseConfigValue("voice.lexicon", [{ term: "x", say: "y", extra: 1 }]).ok).toBe(false);
    expect(parseConfigValue("voice.lexicon", [{ term: "x", say: "y", lang: "Chinese" }]).ok).toBe(
      false,
    );
    expect(parseConfigValue("voice.lexicon", "WebRTC=Web R T C").ok).toBe(false);
  });

  it("/dev/config edits it as JSON", () => {
    expect(isStructured("voice.lexicon")).toBe(true);
    expect(isStructured("words.undoMs")).toBe(false);
    const t = [{ term: "A", say: "a" }];
    expect(valueText("voice.lexicon", t)).toBe(JSON.stringify(t, null, 2));
    expect(valueText("words.undoMs", 8000)).toBe("8000");
    expect(draftValue("voice.lexicon", JSON.stringify(t))).toEqual(t);
    // Not JSON: sent as typed, and the schema refuses it.
    expect(draftValue("voice.lexicon", "[oops")).toBe("[oops");
  });
});

describe("the voice session reads the spoken form; the line keeps the written one", () => {
  it("speechSynthesis gets each sentence with its terms replaced", () => {
    const spoken: UtterLike[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      touch: () => false,
    });
    const line = "Open the WebRTC link. Then the API.";
    expect(v.reply(line)).toBe(true);
    expect(spoken.map((u) => u.text)).toEqual(["Open the Web R T C link."]);
    spoken[0]!.onend?.();
    expect(spoken.map((u) => u.text)).toEqual(["Open the Web R T C link.", "Then the A P I."]);
    expect(line).toBe("Open the WebRTC link. Then the API.");
  });
});
