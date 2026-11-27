/**
 * PR 2a, the roadmap model: the ordering notation (1, 2A, 2B, 3), doc steps
 * and their checklist, images through the file store (a full quota refuses
 * the image, the Markdown still saves), the pace-based estimate and the
 * on-pace verdict against the target date.
 */
import { describe, expect, it } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { normalizeSteps, parseStepLabel, stages, stepLabel } from "@/lib/roadmap/notation";
import {
  countChecks,
  docProgress,
  logToggle,
  setCheck,
  taskItems,
} from "@/lib/roadmap/doc-checklist";
import {
  addDays,
  dailyCounts,
  overallShare,
  paceRate,
  paceVerdict,
  roadmapEta,
  stepEta,
} from "@/lib/roadmap/eta";
import { dayText, etaText, needText, verdictText } from "@/lib/roadmap/eta-text";
import { addDocImage, applyImageUpload, imageSrc, insertImage } from "@/lib/roadmap/doc-image";
import { checkRoadmapPatch } from "@/lib/roadmap/patch";
import { fitRoadmap } from "@/lib/roadmap/generate-schema";
import { roadmapPrompt } from "@/lib/roadmap/prompt";
import { SaveRoadmapSchema } from "@/lib/roadmap/save-schema";
import { measureStep, loadDeckStats } from "@/lib/roadmap/measure";
import { uploadErrorOf } from "@/lib/import/uploads-client";
import { storeUpload, type InboxBucket, type InboxDeps } from "@/lib/inbox/handlers";
import type { InboxDb } from "@/lib/inbox/store";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";
import { activeState, PACE_STATES } from "@/app/(app)/roadmap/components/PaceIndicator";
import { readerIdOf } from "@/app/(app)/roadmap/components/DocEditor";
import type { StepMeasure } from "@/types/roadmap";

const node = (i: number, extra: { measure?: StepMeasure; [k: string]: unknown } = {}) => ({
  id: `n${i}`,
  title: `Step ${i}`,
  description: "",
  keywords: ["k"],
  order: i,
  ...extra,
});

describe("ordering notation", () => {
  it("parses stage numbers and lane letters", () => {
    expect(parseStepLabel("1")).toEqual({ stage: 1 });
    expect(parseStepLabel("2B")).toEqual({ stage: 2, lane: "B" });
    expect(parseStepLabel(" 3 c ")).toEqual({ stage: 3, lane: "C" });
    expect(parseStepLabel("２Ａ")).toEqual({ stage: 2, lane: "A" }); // full-width
    expect(parseStepLabel(4)).toEqual({ stage: 4 });
    for (const bad of ["", "0", "A", "2AB", "-1", "1.5", null, 2.5])
      expect(parseStepLabel(bad)).toBeNull();
  });

  it("renders 1, 2A, 2B, 2C, 3", () => {
    const steps = normalizeSteps([
      node(0, { stage: 1 }),
      node(1, { stage: 2, lane: "A" }),
      node(2, { stage: 2, lane: "B" }),
      node(3, { stage: 2, lane: "C" }),
      node(4, { stage: 3 }),
    ]);
    expect(steps.map(stepLabel)).toEqual(["1", "2A", "2B", "2C", "3"]);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(stages(steps).map((g) => g.length)).toEqual([1, 3, 1]);
  });

  it("makes stages dense and letters only where a stage is shared", () => {
    const steps = normalizeSteps([
      node(0, { stage: 5, lane: "A" }), // alone in its stage: no letter
      node(1, { stage: 9, lane: "D" }),
      node(2, { stage: 9, lane: "B" }),
      node(3, { stage: 2 }),
    ]);
    expect(steps.map(stepLabel)).toEqual(["1", "2", "3A", "3B"]);
    expect(steps.map((s) => s.id)).toEqual(["n3", "n0", "n2", "n1"]);
  });

  it("reads an old roadmap (plain order) as one stage per step", () => {
    const old = [node(2), node(0), node(1)].map(({ id, title, description, keywords, order }) => ({
      id,
      title,
      description,
      keywords,
      order,
    }));
    const steps = normalizeSteps(old);
    expect(steps.map(stepLabel)).toEqual(["1", "2", "3"]);
    expect(steps.map((s) => s.id)).toEqual(["n0", "n1", "n2"]);
    // An old step's label without normalizing is still order + 1.
    expect(stepLabel({ order: 4 })).toBe("5");
  });

  it("the generator's step labels survive fitRoadmap and save as is", () => {
    const fitted = fitRoadmap(
      {
        nodes: [
          { title: "Kana", step: "1" },
          { title: "Grammar", step: "2B" },
          { title: "Vocabulary", step: "2A", deck: "ja-jlpt-n3" },
          { title: "Mock exam", step: "3", checklist: ["- [ ] Paper 1", "Paper 2", ""] },
          { title: "Made-up deck", step: "3", deck: "xx-not-offered" },
        ],
      },
      { decks: ["ja-jlpt-n3"] },
    )!;
    expect(fitted.nodes.map(stepLabel)).toEqual(["1", "2A", "2B", "3A", "3B"]);
    expect(fitted.nodes.map((n) => n.title)).toEqual([
      "Kana",
      "Vocabulary",
      "Grammar",
      "Mock exam",
      "Made-up deck",
    ]);
    expect(fitted.nodes[1]).toMatchObject({ kind: "deck", deck: { id: "ja-jlpt-n3" } });
    expect(fitted.nodes[3]).toMatchObject({
      kind: "doc",
      doc: { markdown: "- [ ] Paper 1\n- [ ] Paper 2" },
    });
    expect(fitted.nodes[4].kind).toBeUndefined(); // an id that was not offered is dropped
    const parsed = SaveRoadmapSchema.safeParse({ topic: "jlpt n3", nodes: fitted.nodes });
    expect(parsed.success).toBe(true);
  });

  it("the prompt asks for the notation and offers only the matched decks", () => {
    const p = roadmapPrompt("pass jlpt n3", [{ id: "ja-jlpt-n3", name: "Japanese · JLPT N3" }]);
    expect(p).toContain('"1", "2A", "2B", "2C", "3"');
    expect(p).toContain("- ja-jlpt-n3: Japanese · JLPT N3");
    expect(roadmapPrompt("python", [])).not.toContain("deck ids");
  });
});

describe("doc checklist", () => {
  const md = [
    "# Plan",
    "- [x] read chapter 1",
    "- [ ] read chapter 2",
    "  - [x] part a", // nested
    "    * [ ] part b", // deeper, another bullet
    "1. [X] numbered",
    "> - [ ] quoted",
    "```",
    "- [ ] in code: not counted",
    "```",
    "- not a task",
    "- [] not a task either",
  ].join("\n");

  it("counts ticked over all items, nested ones too, code skipped", () => {
    expect(countChecks(md)).toEqual({ done: 3, total: 6 });
    expect(docProgress(md)).toBe(0.5);
  });

  it("no checkboxes: progress is n/a", () => {
    expect(countChecks("just text\n- a list")).toEqual({ done: 0, total: 0 });
    expect(docProgress("")).toBeNull();
    expect(
      measureStep(
        {
          ...node(0),
          kind: "doc",
          doc: { markdown: "text" },
          totalCards: 0,
          matureCards: 0,
          maturityRate: 0,
        },
        { today: "2026-11-27", windowDays: 7, decks: {} },
      ).total,
    ).toBeNull();
  });

  it("toggles one item by its index and leaves the rest as written", () => {
    const next = setCheck(md, 3, true); // "part b"
    expect(next.split("\n")[4]).toBe("    * [x] part b");
    expect(countChecks(next)).toEqual({ done: 4, total: 6 });
    expect(setCheck(next, 0, false).split("\n")[1]).toBe("- [ ] read chapter 1");
    expect(setCheck(md, 99, true)).toBe(md);
    expect(taskItems(md).map((t) => t.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the pace log grows on a tick and shrinks on an untick", () => {
    const t = new Date("2026-11-27T10:00:00Z");
    const log = logToggle(logToggle([], true, t), true, t);
    expect(log.length).toBe(2);
    expect(logToggle(log, false, t).length).toBe(1);
    expect(logToggle(Array(5).fill(t.toISOString()), true, t, 5).length).toBe(5);
  });
});

describe("images in a doc", () => {
  it("inserts the site address on its own line", () => {
    const r = insertImage("ab", 1, "cat", imageSrc("x1"));
    expect(r.md).toBe("a\n![cat](/api/my/files/x1)\nb");
  });

  it("a full file space refuses the image; the Markdown stays and still saves", async () => {
    // The store's own answer for a full quota (lib/inbox/handlers.ts storeUpload).
    const d1 = createTestD1(testSchema());
    const store = new Map<string, Uint8Array>();
    const bucket: InboxBucket = {
      async put(k, b) {
        store.set(k, new Uint8Array(await new Response(b).arrayBuffer()));
      },
      async get() {
        return null;
      },
      async delete(k) {
        store.delete(k);
      },
    };
    const deps: InboxDeps = {
      who: async () => ({ id: "u1", email: "a@x.test", owner: false }),
      db: () => d1 as unknown as InboxDb,
      bucket: () => bucket,
      limits: async () => ({
        maxFileBytes: 1e6,
        maxDayBytes: 1e6,
        maxStoredBytes: 8,
        uploadsPerMinute: 30,
      }),
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const res = await storeUpload(
      new Request("https://x/api/import/files?source=roadmap", {
        method: "POST",
        headers: {
          "content-length": String(png.length),
          "content-type": "image/png",
          "x-file-name": "a.png",
        },
        body: png,
      }),
      { id: "u1" },
      deps,
      "roadmap",
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("storage-cap");
    expect(store.size).toBe(0);
    const reason = uploadErrorOf(res.status, body.error);
    expect(reason).toBe("full");

    // The page: the image is refused, the text is untouched…
    const md = "- [ ] my notes";
    const out = await addDocImage(
      Object.assign(new Blob([png], { type: "image/png" }), { name: "a.png" }),
      md,
      md.length,
      () => ({ done: Promise.resolve({ ok: false, error: reason }), abort: () => {} }),
    );
    expect(out).toEqual({ ok: false, md, reason: "full" });
    // …and saving the Markdown goes through as always.
    const patch = checkRoadmapPatch(
      { nodes: [{ ...node(0), kind: "doc", doc: { markdown: `${out.md}\nmore text` } }] },
      20000,
    );
    expect(patch.ok).toBe(true);
  });

  it("an image that was stored goes into the Markdown", () => {
    const out = applyImageUpload("x", 1, "Kanji chart.png", { ok: true, id: "abc" });
    expect(out).toEqual({ ok: true, md: "x\n![Kanji chart](/api/my/files/abc)", caret: 35 });
  });

  it("the PATCH check: shape, length cap, notation order", () => {
    expect(checkRoadmapPatch({}, 100)).toMatchObject({ ok: false, status: 400 });
    expect(checkRoadmapPatch({ targetDate: "2026-02-30" }, 100)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(checkRoadmapPatch({ targetDate: null }, 100)).toEqual({
      ok: true,
      patch: { targetDate: null },
    });
    const long = { nodes: [{ ...node(0), kind: "doc", doc: { markdown: "x".repeat(101) } }] };
    expect(checkRoadmapPatch(long, 100)).toMatchObject({
      ok: false,
      status: 413,
      error: "doc-too-long",
    });
    const r = checkRoadmapPatch({ nodes: [node(1, { stage: 2 }), node(0, { stage: 1 })] }, 100);
    expect(r.ok && r.patch.nodes?.map((n) => n.id)).toEqual(["n0", "n1"]);
    expect(
      checkRoadmapPatch({ nodes: [node(0, { doc: { url: "javascript:alert(1)" } })] }, 100).ok,
    ).toBe(false);
  });

  it("a Reader link or id becomes the doc's readerId", () => {
    expect(readerIdOf("https://lianki.com/reader/abc_123?x=1")).toBe("abc_123");
    expect(readerIdOf("abc-9")).toBe("abc-9");
    expect(readerIdOf("not an id")).toBe("");
  });
});

const TODAY = "2026-11-27";
const settings = { today: TODAY, minActiveDays: 3 };
const words = (done: number, total: number, daily: number[]): StepMeasure => ({
  unit: "words",
  done,
  total,
  daily,
});

describe("pace-based estimate", () => {
  it("steady: 10 a day, 100 left → 10 days", () => {
    const e = stepEta(words(0, 100, Array(14).fill(10)), settings);
    expect(e).toMatchObject({ kind: "eta", days: 10, date: addDays(TODAY, 10), rate: 10 });
  });

  it("accelerating: recent days weigh more than the plain mean", () => {
    const ramp = Array.from({ length: 14 }, (_, i) => i * 2); // 0, 2, …, 26
    const mean = ramp.reduce((a, b) => a + b) / ramp.length;
    expect(paceRate(ramp)).toBeGreaterThan(mean);
    const e = stepEta(words(0, 200, ramp), settings);
    expect(e.kind).toBe("eta");
    if (e.kind === "eta") expect(e.days).toBeLessThan(Math.ceil(200 / mean));
  });

  it("no data, or too few active days: says so instead of guessing", () => {
    expect(stepEta(words(0, 100, Array(14).fill(0)), settings)).toEqual({
      kind: "too-little",
      activeDays: 0,
    });
    const two = [...Array(12).fill(0), 50, 50];
    expect(stepEta(words(0, 100, two), settings)).toEqual({ kind: "too-little", activeDays: 2 });
    expect(stepEta(undefined, settings)).toEqual({ kind: "na" });
  });

  it("a finished step is done whatever its log", () => {
    expect(stepEta(words(710, 710, Array(14).fill(0)), settings)).toEqual({ kind: "done" });
    expect(stepEta({ unit: "cards", done: 3, total: 3, daily: null }, settings)).toEqual({
      kind: "done",
    });
    expect(stepEta({ unit: "cards", done: 1, total: 3, daily: null }, settings)).toEqual({
      kind: "na",
    });
  });

  it("daily counts: days of a log and per-day rows, oldest first", () => {
    expect(
      dailyCounts(
        ["2026-11-27T01:00:00Z", "2026-11-27T23:00:00Z", "2026-11-25T12:00:00Z", "bad"],
        TODAY,
        3,
      ),
    ).toEqual([1, 0, 2]);
    expect(dailyCounts({ "2026-11-26": 4, "2026-10-01": 9 }, TODAY, 2)).toEqual([4, 0]);
  });

  it("the whole roadmap: a stage lasts as long as its slowest lane, stages add up", () => {
    const steps = normalizeSteps([
      node(0, { stage: 1, measure: words(0, 50, Array(14).fill(10)) }), // 5 days
      node(1, { stage: 2, measure: words(0, 100, Array(14).fill(10)) }), // 10 days
      node(2, {
        stage: 2,
        measure: { unit: "items", done: 0, total: 6, daily: Array(14).fill(1) },
      }), // 6 days
      node(3, { stage: 3, measure: { unit: "cards", done: 0, total: 9, daily: null } }), // not measured
    ]);
    const e = roadmapEta(steps, settings);
    expect(e).toMatchObject({ kind: "eta", days: 15, date: addDays(TODAY, 15) });
    if (e.kind === "eta") expect(e.remaining).toEqual({ words: 150, items: 6 });
    expect(overallShare(steps)).toBe(0);
    expect(roadmapEta([node(0, { measure: words(0, 9, Array(14).fill(0)) })], settings)).toEqual({
      kind: "too-little",
      steps: 1,
    });
    expect(roadmapEta([node(0, { measure: undefined })], settings)).toEqual({ kind: "na" });
    expect(roadmapEta([node(0, { measure: words(9, 9, [0]) })], settings)).toEqual({
      kind: "done",
    });
  });

  it("deck stats come from the learner's lists of that deck (D1, read only)", async () => {
    const d1 = createTestD1(testSchema());
    const raw = (d1 as unknown as { raw(): { exec(s: string): void } }).raw();
    raw.exec(
      `INSERT INTO word_lists (email, id, name, lang, source, created_at, updated_at) VALUES ('a@x', 'l1', 'N3', 'ja', 'ja-jlpt-n3', '', '')`,
    );
    raw.exec(
      `INSERT INTO word_cards (email, list_id, term, card, card_due, updated_at) VALUES ('a@x', 'l1', 'w1', '{}', '', ''), ('a@x', 'l1', 'w2', '{}', '', '')`,
    );
    raw.exec(`INSERT INTO word_reviews (email, list_id, term, rating, state, reviewed_at) VALUES
      ('a@x', 'l1', 'w1', 3, 0, '2026-11-26T10:00:00Z'), ('a@x', 'l1', 'w2', 3, 0, '2026-11-26T11:00:00Z'),
      ('a@x', 'l1', 'w1', 3, 2, '2026-11-27T10:00:00Z'), ('a@x', 'l1', 'w9', 3, 0, '2026-10-01T10:00:00Z')`);
    const stats = await loadDeckStats(
      d1,
      "a@x",
      ["ja-jlpt-n3", "ja-jlpt-n1"],
      { "ja-jlpt-n3": 100 },
      TODAY,
      7,
    );
    expect(stats["ja-jlpt-n3"]).toEqual({
      seen: 2,
      total: 100,
      byDay: { "2026-11-26": 2, "2026-11-27": 0 },
    });
    expect(stats["ja-jlpt-n1"]).toEqual({ seen: 0, total: 0, byDay: {} });
  });
});

describe("on pace for the target date", () => {
  const eta = (days: number) => ({
    kind: "eta" as const,
    days,
    date: addDays(TODAY, days),
    remaining: { words: 300, items: 4 },
    rate: { words: 10 },
  });

  it("every state, and only one active", () => {
    expect(paceVerdict(eta(30), addDays(TODAY, 30), TODAY, 7)).toEqual({
      state: "on-pace",
      target: addDays(TODAY, 30),
      slack: 0,
    });
    expect(paceVerdict(eta(30), addDays(TODAY, 40), TODAY, 7)).toMatchObject({
      state: "ahead",
      by: 10,
    });
    expect(paceVerdict(eta(30), addDays(TODAY, 35), TODAY, 7)).toMatchObject({
      state: "on-pace",
      slack: 5,
    });
    expect(paceVerdict(eta(30), addDays(TODAY, 20), TODAY, 7)).toEqual({
      state: "behind",
      target: addDays(TODAY, 20),
      by: 10,
      need: { words: 15, items: 1 },
    });
    expect(
      paceVerdict({ kind: "too-little", steps: 1 }, addDays(TODAY, 20), TODAY, 7),
    ).toMatchObject({ state: "no-data" });
    expect(paceVerdict(eta(30), null, TODAY, 7)).toEqual({ state: "no-target" });
    expect(paceVerdict({ kind: "done" }, addDays(TODAY, 3), TODAY, 7)).toMatchObject({
      state: "ahead",
      by: 3,
    });
    expect(PACE_STATES).toEqual(["on-pace", "ahead", "behind", "no-data"]);
    expect(activeState({ state: "no-target" })).toBeNull();
    expect(activeState({ state: "behind", target: TODAY, by: 1, need: {} })).toBe("behind");
  });

  it("moving the target date changes the verdict at once (pure recompute)", () => {
    const e = eta(30);
    const states = [10, 30, 60].map((d) => paceVerdict(e, addDays(TODAY, d), TODAY, 7).state);
    expect(states).toEqual(["behind", "on-pace", "ahead"]);
  });

  it("words: 'behind by N days, need ~X a day to hit <date>'", () => {
    const s = {
      daysOne: "{n} day",
      daysOther: "{n} days",
      etaLine: "about {days}, ~{date}",
      etaFinished: "Finished",
      etaTooLittle: "too little",
      etaNone: "none",
      paceOnPaceDetail: "On pace to finish by {date}.",
      paceAheadDetail: "Ahead by {days}: before {date}.",
      paceBehindDetail: "Behind by {days}: you need about {need} a day to finish by {date}.",
      paceNoDataDetail: "No data for {date}.",
      paceNoTarget: "Set a date.",
      needWords: "{n} new words",
      needItems: "{n} checklist items",
    };
    const v = paceVerdict(eta(30), "2026-12-17", TODAY, 7);
    expect(verdictText(v, "en", TODAY, s)).toBe(
      "Behind by 10 days: you need about 15 new words + 1 checklist items a day to finish by December 17.",
    );
    expect(etaText(eta(1), "en", TODAY, s)).toBe("about 1 day, ~November 28");
    expect(dayText("2027-03-01", "en", TODAY)).toBe("March 1, 2027");
    expect(needText({ words: 1200 }, "en", s)).toBe("1,200 new words");
  });
});

describe("D1: the target date and edits", () => {
  it("saves, reads and clears the target date; renames the goal", async () => {
    const d1 = createTestD1(testSchema());
    const repo = new RoadmapGoalsD1Repo(d1, "a@x");
    const now = new Date("2026-11-27T00:00:00Z");
    const id = await repo.upsertByTopic({
      topic: "N3",
      nodes: [node(0)],
      createdAt: now,
      updatedAt: now,
    });
    expect((await repo.getById(id))?.targetDate).toBeNull();
    await repo.update(id, { targetDate: "2027-07-05", topic: "Pass N3" });
    expect(await repo.getById(id)).toMatchObject({ topic: "Pass N3", targetDate: "2027-07-05" });
    await repo.update(id, { targetDate: null });
    expect((await repo.getById(id))?.targetDate).toBeNull();
    // Saving the roadmap again (regenerate) keeps its date.
    await repo.update(id, { targetDate: "2027-07-05" });
    await repo.upsertByTopic({
      topic: "Pass N3",
      nodes: [node(1)],
      createdAt: now,
      updatedAt: now,
    });
    expect((await repo.getById(id))?.targetDate).toBe("2027-07-05");
  });
});
