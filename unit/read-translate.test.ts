/**
 * The reader's Translate (lib/read/translate.ts, lib/read/translate-server.ts):
 * the language named from its code, the shared cache paid once, the real cost
 * counted, and a failing model leaving nothing cached.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { Complete } from "@/lib/read/gloss-server";
import {
  cleanTranslation,
  langName,
  langTag,
  normText,
  translateMessages,
  translationKey,
  translationParts,
} from "@/lib/read/translate";
import { translate } from "@/lib/read/translate-server";

describe("rules", () => {
  test("a target is a BCP 47 code, named by Intl", () => {
    expect(langTag("zh-Hans")).toBe("zh-Hans");
    expect(langTag("pt-br")).toBe("pt-BR");
    expect(langTag("en; drop table")).toBeNull();
    expect(langTag(3)).toBeNull();
    expect(langTag("de-1996-1996")).toBeNull(); // the shape, but not a tag Intl takes
    expect(langName("ja")).toBe("Japanese");
    expect(langName("de-1996-1996")).toBe("de-1996-1996"); // no name: the code itself
    expect(translateMessages("Bonjour", "zh", "fr")[0].content).toContain(
      "from French into Chinese",
    );
  });

  test("the text is normalised so the same passage shares one cache row", () => {
    expect(normText("  Il  était une fois.\n\n\n\nLa fin. ")).toBe("Il était une fois.\n\nLa fin.");
  });

  test("a wrapping pair of quotes is dropped; inner quotes stay", () => {
    expect(cleanTranslation(' "从前有一次。" ')).toBe("从前有一次。");
    expect(cleanTranslation('"a" and "b"')).toBe('"a" and "b"');
  });
});

describe("translate (D1)", () => {
  let d1: TestD1Database;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
  });

  test("the model once, then the cache; the text itself is not stored", async () => {
    let calls = 0;
    const complete: Complete = async (body) => {
      calls++;
      expect(body.messages).toBeDefined();
      return {
        choices: [{ message: { content: "从前有一次。" } }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      };
    };
    const input = { text: "Il était une fois.", to: "zh", from: "fr" };
    expect(await translate(d1, input, { userId: "u1", complete })).toEqual({
      ok: true,
      text: "从前有一次。",
      cached: false,
    });
    const again = await translate(
      d1,
      { ...input, text: "  Il  était une fois. " },
      {
        userId: "u1",
        complete,
      },
    );
    expect(again).toEqual({ ok: true, text: "从前有一次。", cached: true });
    expect(calls).toBe(1);
    const rows = d1.raw().prepare("SELECT * FROM read_translation").all() as Record<
      string,
      unknown
    >[];
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("était");
    // Another target is another translation.
    await translate(d1, { ...input, to: "ja" }, { userId: "u1", complete });
    expect(calls).toBe(2);
  });

  test("a failing model caches nothing", async () => {
    const complete: Complete = async () => {
      throw new Error("down");
    };
    const r = await translate(
      d1,
      { text: "Bonjour", to: "en", from: null },
      {
        userId: "u2",
        complete,
      },
    );
    expect(r).toEqual({ ok: false, error: "model-failed" });
    expect(d1.raw().prepare("SELECT COUNT(*) AS n FROM read_translation").get()).toEqual({ n: 0 });
  });
});

describe("translator's notes", () => {
  test("the prompt names the note's language and limits; without notes, none", () => {
    const on = translateMessages("Bonjour", "zh", "fr", true)[0].content;
    expect(on).toContain("translator's note in Chinese");
    expect(on).toContain("Most texts need none");
    expect(translateMessages("Bonjour", "zh", "fr")[0].content).toContain("no notes");
  });
  test("a translation made without notes does not pass as one made with them", async () => {
    expect(await translationKey("zh", "a", true)).not.toBe(await translationKey("zh", "a"));
    const d1 = createTestD1(testSchema());
    let calls = 0;
    const complete: Complete = async () => {
      calls++;
      return { choices: [{ message: { content: "x" } }] };
    };
    const input = { text: "note key", to: "zh", from: null };
    await translate(d1, input, { userId: "n1", complete });
    await translate(d1, { ...input, notes: true }, { userId: "n1", complete });
    await translate(d1, { ...input, notes: true }, { userId: "n1", complete });
    expect(calls).toBe(2);
  });
  test("a translation is cut at its notes; a broken marker never shows", () => {
    expect(translationParts("先生⟦honorific⟧好。")).toEqual([
      { text: "先生", note: false },
      { text: "honorific", note: true },
      { text: "好。", note: false },
    ]);
    expect(translationParts("plain")).toEqual([{ text: "plain", note: false }]);
    expect(translationParts("a⟦cut off")).toEqual([{ text: "a", note: false }]);
    expect(translationParts("a⟧b⟦ ⟧")).toEqual([{ text: "ab", note: false }]);
  });
});
