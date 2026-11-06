// /vibe's translations (docs/vibe.md, "Translations"): which languages, which lines,
// the private cache, no second charge, pause, delete. Invented text and a stubbed
// model; no microphone, no audio.
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { deleteReadMaterial, getReadMaterialById } from "@/lib/getReadMaterialsCollection";
import { useBackend, useBlobs, useD1 } from "./support/testMocks";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { Complete } from "@/lib/read/gloss-server";
import type { D1Batch } from "@/lib/read/reader-store";
import { linesReply, startReply, stateReply, translateLineReply } from "@/lib/vibe/api";
import { sweepVibeDocs } from "@/lib/vibe/retention";
import { setRetentionDays } from "@/lib/vibe/store";
import { docTranslations } from "@/lib/vibe/translate-server";
import {
  checkShare,
  conversationLangs,
  createTranslator,
  MIN_SHARE_DEFAULT,
  targetsOf,
} from "@/lib/vibe/translations";

const T0 = 1_800_000_000_000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

describe("which languages", () => {
  it("any language above the share, with no fixed pair", () => {
    expect(conversationLangs(["fr", "zh", "fr", "zh"])).toEqual(["fr", "zh"]);
    expect(conversationLangs(["sw", "sw", "mr"])).toEqual(["sw", "mr"]);
    expect(conversationLangs(["en", "ko", "ja", "en", "ko", "ja"]).length).toBe(3);
  });
  it("above, not at: exactly the share does not count", () => {
    expect(conversationLangs(["a", "a", "a", "a", "b"], 20)).toEqual(["a"]);
    expect(conversationLangs(["a", "a", "a", "b"], 20)).toEqual(["a", "b"]);
  });
  it("the share is the setting's, 20 by default", () => {
    expect(MIN_SHARE_DEFAULT).toBe(20);
    const langs = ["a", "a", "a", "b"]; // b is 25%
    expect(conversationLangs(langs)).toContain("b");
    expect(conversationLangs(langs, 30)).toEqual(["a"]);
    expect(conversationLangs(langs, 10)).toContain("b");
    for (const bad of [0, 100, 1.5, "20", null]) expect(checkShare(bad)).toBe(20);
    expect(checkShare(35)).toBe(35);
  });
  it("lines with no language yet do not count; one language has nothing to go into", () => {
    expect(conversationLangs([undefined, null, "a"])).toEqual(["a"]);
    expect(targetsOf("a", ["a"])).toEqual([]);
    expect(targetsOf("a", ["a", "b"])).toEqual(["b"]);
    expect(targetsOf(undefined, ["a", "b"])).toEqual([]);
  });
});

describe("the queue", () => {
  const make = (over: Partial<Parameters<typeof createTranslator>[0]> = {}, known = []) => {
    const asked: string[] = [];
    let run = true;
    const tr = createTranslator(
      {
        ask: async (text, to) => {
          asked.push(`${text}>${to}`);
          return `[${to}] ${text}`;
        },
        canRun: () => run,
        minPct: () => 20,
        onChange: () => {},
        ...over,
      },
      known,
    );
    return { tr, asked, set: (v: boolean) => (run = v) };
  };

  it("never into its own language; a language's arrival brings earlier lines along", async () => {
    const { tr, asked } = make();
    tr.update([{ text: "first", lang: "fr" }]);
    await settle();
    expect(asked).toEqual([]);
    tr.update([
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ]);
    await settle();
    expect(asked.sort()).toEqual(["first>zh", "second>fr"]);
    expect(tr.get("first", "zh")).toBe("[zh] first");
    expect(tr.get("first", "fr")).toBeUndefined();
  });

  it("each only once, whatever comes after", async () => {
    const { tr, asked } = make();
    const lines = [
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ];
    tr.update(lines);
    await settle();
    tr.update(lines);
    tr.update([...lines]);
    await settle();
    expect(asked.length).toBe(2);
  });

  it("paused or a log only being read: nothing is sent", async () => {
    const { tr, asked, set } = make();
    set(false);
    tr.update([
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ]);
    await settle();
    expect(asked).toEqual([]);
    set(true);
    tr.update([
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ]);
    await settle();
    expect(asked.length).toBe(2);
  });

  it("what the log already has shows, and is not asked for", async () => {
    const asked: string[] = [];
    const tr = createTranslator(
      {
        ask: async (text, to) => {
          asked.push(`${text}>${to}`);
          return "x";
        },
        canRun: () => true,
        minPct: () => 20,
        onChange: () => {},
      },
      [{ line: "first", target: "zh", out: "kept" }],
    );
    tr.update([
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ]);
    await settle();
    expect(tr.get("first", "zh")).toBe("kept");
    expect(asked).toEqual(["second>fr"]);
  });

  it("a failure stays that line's, is not retried in a loop, and the rest go on", async () => {
    const asked: string[] = [];
    const tr = createTranslator({
      ask: async (text, to) => {
        asked.push(`${text}>${to}`);
        if (text === "bad") throw new Error("down");
        return "ok";
      },
      canRun: () => true,
      minPct: () => 20,
      onChange: () => {},
    });
    const lines = [
      { text: "good", lang: "fr" },
      { text: "bad", lang: "zh" },
    ];
    tr.update(lines);
    await settle();
    tr.update([...lines]);
    await settle();
    expect(tr.get("bad", "fr")).toBe("failed");
    expect(tr.get("good", "zh")).toBe("ok");
    expect(asked.filter((a) => a.startsWith("bad")).length).toBe(1);
  });

  it("a language that falls below keeps what it got, and gets no more", async () => {
    const { tr, asked } = make();
    const lines = [
      { text: "first", lang: "fr" },
      { text: "second", lang: "zh" },
    ];
    tr.update(lines);
    await settle();
    const many = [
      ...lines,
      ...["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((text) => ({ text, lang: "fr" })),
    ];
    tr.update(many);
    await settle();
    expect(asked.length).toBe(2);
    expect(tr.shownFor(many[1])).toContain("fr");
    expect(tr.shownFor(many[0])).toContain("zh");
  });
});

describe("the route's answers", () => {
  let d1: TestD1Database;
  let db: D1Batch;
  let calls = 0;
  const model: Complete = async () => {
    calls++;
    return {
      choices: [{ message: { content: "une traduction inventée" } }],
      usage: { prompt_tokens: 90, completion_tokens: 25 },
    };
  };

  beforeEach(() => {
    calls = 0;
    d1 = createTestD1(testSchema());
    db = d1 as unknown as D1Batch;
    useD1(d1);
    useBackend("d1");
    for (const u of ["u1", "u2"])
      d1.exec(
        `INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES ('${u}', '${u}@example.com', '${u}', 1, 0, 0)`,
      );
    const blobs = new Map<string, string>();
    useBlobs({
      put: async (k: string, v: string) => void blobs.set(k, v),
      get: async (k: string) => (blobs.has(k) ? { text: async () => blobs.get(k)! } : null),
      delete: async (k: string) => void blobs.delete(k),
    });
  });

  const convo = async () => {
    const id = (await startReply(db, "u1", { tap: true, title: "T" }, T0)).body.id as string;
    const r = await linesReply(db, "u1", id, { from: 0, lines: ["An invented line said."] }, T0);
    return { id, material: r.body.material as string };
  };
  const ask = (id: string, over: Record<string, unknown> = {}, user = "u1") =>
    translateLineReply(
      db,
      user,
      id,
      { text: "An invented line said.", to: "fr", from: "en", ...over },
      T0,
      model,
    );

  it("translates a finished line, and answers again from the doc: one model call, one charge", async () => {
    const { id } = await convo();
    const a = await ask(id);
    expect(a).toEqual({ status: 200, body: { text: "une traduction inventée", cached: false } });
    const b = await ask(id);
    expect(b).toEqual({ status: 200, body: { text: "une traduction inventée", cached: true } });
    expect(calls).toBe(1);
    expect(await docTranslations(db, id)).toEqual([
      { line: "An invented line said.", target: "fr", out: "une traduction inventée" },
    ]);
  });

  it("never into the shared cache", async () => {
    const { id } = await convo();
    await ask(id);
    expect((await db.prepare("SELECT key FROM read_translation").bind().all()).results).toEqual([]);
  });

  it("paused: refused, no call; resumed: it goes", async () => {
    const { id } = await convo();
    await stateReply(db, "u1", id, { state: "paused" });
    expect((await ask(id)).status).toBe(409);
    expect(calls).toBe(0);
    await stateReply(db, "u1", id, { state: "running" });
    expect((await ask(id)).status).toBe(200);
  });

  it("only its own lines, only its own doc", async () => {
    const { id } = await convo();
    expect((await ask(id, { text: "something never said" })).status).toBe(400);
    expect((await ask(id, {}, "u2")).status).toBe(404);
    expect((await ask(id, { to: "not a tag!" })).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("a model failure answers 502 and leaves the transcript and the cache alone", async () => {
    const { id, material } = await convo();
    const bad: Complete = async () => {
      throw new Error("down");
    };
    const r = await translateLineReply(
      db,
      "u1",
      id,
      { text: "An invented line said.", to: "fr", from: "en" },
      T0,
      bad,
    );
    expect(r.status).toBe(502);
    expect(await docTranslations(db, id)).toEqual([]);
    expect((await getReadMaterialById("u1", material))!.lines).toEqual(["An invented line said."]);
  });

  it("deleting the doc takes its translations, by hand or by the chosen number", async () => {
    const a = await convo();
    await ask(a.id);
    await deleteReadMaterial("u1", a.material);
    expect((await db.prepare("SELECT doc_id FROM vibe_translation").bind().all()).results).toEqual(
      [],
    );
    const b = await convo();
    await ask(b.id);
    await setRetentionDays(db, "u1", 1, T0);
    await sweepVibeDocs(db, null, T0 + 2 * 86_400_000);
    expect((await db.prepare("SELECT doc_id FROM vibe_translation").bind().all()).results).toEqual(
      [],
    );
  });

  it("polish stays refused for these docs, and the reader's own translate cache is untouched", () => {
    expect(readFileSync("lib/read/polish-offer.ts", "utf8")).toContain(
      'NEVER_OFFERED = new Set<BookSource>(["vibe"])',
    );
    expect(readFileSync("lib/vibe/translate-server.ts", "utf8")).not.toContain(
      "read_translation (",
    );
  });

  it("the column is the page's; a word's tap stores nothing and asks no model", () => {
    const words = readFileSync("app/(app)/vibe/VibeWords.tsx", "utf8");
    expect(words).toContain("fetchCachedGloss");
    expect(words).not.toMatch(/fetchGloss\(/);
    const client = readFileSync("app/(app)/vibe/VibeClient.tsx", "utf8");
    expect(client).toContain(
      'may.current.status === "running" || may.current.status === "stopped"',
    );
  });
});
