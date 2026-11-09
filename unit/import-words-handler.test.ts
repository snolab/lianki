import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import {
  handleImportJobs,
  handleWordImport,
  importAnyOn,
  type WordImportDeps,
} from "@/lib/import/words-handler";
import { isEntrySource } from "@/lib/words/entry-list";

// docs/import-material.md, M1: POST /api/import/words and GET /api/import/jobs.

const SCHEMA = testSchema();
const EMAIL = "u@example.com";
let d1: TestD1Database;
let deps: WordImportDeps;
beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  deps = { user: { email: EMAIL }, owner: false, flags: { "import.any": true }, db: d1 };
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://lianki.com/api/import/words", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://lianki.com",
      host: "lianki.com",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const haveCard = async (term: string) => {
  await d1
    .prepare(
      `INSERT INTO word_lists (email, id, name, lang, source, created_at, updated_at)
       VALUES (?, 'l0', 'Old', 'en', 'en-1k', 'x', 'x') ON CONFLICT DO NOTHING`,
    )
    .bind(EMAIL)
    .run();
  await d1
    .prepare(
      `INSERT INTO word_cards (email, list_id, term, back, card, card_due, reps, updated_at)
       VALUES (?, 'l0', ?, '', '{}', 'x', 1, 'x')`,
    )
    .bind(EMAIL, term)
    .run();
};

const TEXT =
  "Word,Meaning\napple,a fruit\nBanana,a long fruit\napple,again\n,nothing\ncherry,red\n";

describe("the gate", () => {
  test("flag on: everyone; flag off: the owner only", () => {
    expect(importAnyOn({ "import.any": true }, false)).toBe(true);
    expect(importAnyOn({}, true)).toBe(true);
    expect(importAnyOn({}, false)).toBe(false);
  });

  test("off for this user: 404, nothing written", async () => {
    const r = await handleWordImport(post({ step: "preview", text: TEXT }), { ...deps, flags: {} });
    expect(r.status).toBe(404);
  });

  test("signed out: 401; cross-site: 403", async () => {
    expect(
      (await handleWordImport(post({ step: "preview", text: TEXT }), { ...deps, user: null }))
        .status,
    ).toBe(401);
    const cross = post({ step: "preview", text: TEXT }, { origin: "https://evil.example" });
    expect((await handleWordImport(cross, deps)).status).toBe(403);
  });
});

describe("preview", () => {
  test("counts new, already have and skipped", async () => {
    await haveCard("banana");
    const r = await handleWordImport(
      post({ step: "preview", text: TEXT, fileName: "fruit.csv" }),
      deps,
    );
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ format: "csv", header: true, fresh: 2, have: 1, skipped: 2 });
    expect(b.sample.map((s: { term: string }) => s.term)).toEqual(["apple", "cherry"]);
  });

  test("clear errors: empty, binary, too large", async () => {
    const empty = await handleWordImport(post({ step: "preview", text: "\n\n" }), deps);
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("empty");
    const bin = await handleWordImport(post({ step: "preview", text: "PK\u0000\u0000" }), deps);
    expect((await bin.json()).error).toBe("binary");
    const big = await handleWordImport(
      post({ step: "preview", text: "a".repeat(1_000_001) }),
      deps,
    );
    expect(big.status).toBe(413);
  });
});

describe("commit", () => {
  test("makes a list of the new words only, and a done job", async () => {
    await haveCard("banana");
    const r = await handleWordImport(
      post({ step: "commit", text: TEXT, fileName: "fruit.csv", name: "fruit", lang: "en" }),
      deps,
    );
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ added: 2, have: 1, skipped: 2 });
    const list = await d1
      .prepare("SELECT name, lang, source FROM word_lists WHERE email = ? AND id = ?")
      .bind(EMAIL, b.listId)
      .first<{ name: string; lang: string; source: string }>();
    expect(list).toEqual({ name: "fruit", lang: "en", source: `import:${b.jobId}` });
    expect(isEntrySource(list!.source)).toBe(true);
    const { results } = await d1
      .prepare("SELECT term, back FROM word_list_entries WHERE list_id = ? ORDER BY position")
      .bind(b.listId)
      .all();
    expect(results).toEqual([
      { term: "apple", back: "a fruit" },
      { term: "cherry", back: "red" },
    ]);

    const jobs = await (await handleImportJobs(deps)).json();
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({
      id: b.jobId,
      kind: "wordlist",
      name: "fruit.csv",
      status: "done",
      result_ref: b.listId,
    });
    expect(JSON.parse(jobs.jobs[0].note)).toEqual({ added: 2, have: 1, skipped: 2 });
  });

  test("importing the same file again adds nothing", async () => {
    const body = { step: "commit", text: TEXT, name: "fruit", lang: "en" };
    expect((await handleWordImport(post(body), deps)).status).toBe(200);
    const again = await handleWordImport(post(body), deps);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "nothing-new", have: 3 });
  });

  test("a bad language code is refused", async () => {
    const r = await handleWordImport(
      post({ step: "commit", text: TEXT, name: "x", lang: "<script>" }),
      deps,
    );
    expect(r.status).toBe(400);
  });

  test("jobs are the user's own", async () => {
    await handleWordImport(post({ step: "commit", text: TEXT, name: "fruit", lang: "en" }), deps);
    const other = await (
      await handleImportJobs({ ...deps, user: { email: "other@example.com" } })
    ).json();
    expect(other.jobs).toEqual([]);
  });
});
