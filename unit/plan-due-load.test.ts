import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { DEFAULT_SECONDS_PER_WORD, dueLoad, SECONDS_PER_PAGE } from "@/lib/plan/due-load";

const SCHEMA = testSchema();
const EMAIL = "a@example.com";
let d1: TestD1Database;

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
});

function note(due: string, opts: { email?: string; deleted?: boolean } = {}) {
  const id = crypto.randomUUID();
  d1.raw()
    .prepare(
      `INSERT INTO fsrs_notes (id, email, url, card, card_due, deleted_at) VALUES (?, ?, ?, '{}', ?, ?)`,
    )
    .run(id, opts.email ?? EMAIL, `https://x.test/${id}`, due, opts.deleted ? due : null);
}
function word(due: string) {
  d1.raw()
    .prepare(
      `INSERT INTO word_cards (email, list_id, term, card, card_due, updated_at) VALUES (?, 'l1', ?, '{}', ?, ?)`,
    )
    .run(EMAIL, crypto.randomUUID(), due, due);
}

describe("due load", () => {
  const now = new Date("2026-11-02T03:00:00Z"); // 12:00 in Tokyo, 2 November

  test("buckets by local day; overdue counts on today; deleted and others' cards do not", async () => {
    note("2026-10-20T00:00:00.000Z"); // overdue → today
    note("2026-11-02T14:59:59.000Z"); // 23:59 Tokyo, 2 Nov → today
    note("2026-11-02T15:00:00.000Z"); // 00:00 Tokyo, 3 Nov → tomorrow
    note("2026-11-02T16:00:00.000Z", { deleted: true });
    note("2026-11-02T16:00:00.000Z", { email: "b@example.com" });
    word("2026-11-03T01:00:00.000Z"); // 3 Nov Tokyo
    word("2026-11-03T02:00:00.000Z");
    word("2026-11-20T00:00:00.000Z"); // past the range
    const load = await dueLoad(d1, {
      email: EMAIL,
      tz: "Asia/Tokyo",
      from: "2026-11-02",
      days: 3,
      now,
    });
    expect(load.days.map((d) => [d.day, d.pages, d.words])).toEqual([
      ["2026-11-02", 2, 0],
      ["2026-11-03", 1, 2],
      ["2026-11-04", 0, 0],
    ]);
    expect(load.days[1].estMinutes).toBe(
      Math.round((2 * DEFAULT_SECONDS_PER_WORD + SECONDS_PER_PAGE) / 60),
    );
  });

  test("UTC days when the zone is UTC", async () => {
    note("2026-11-02T23:30:00.000Z");
    const load = await dueLoad(d1, { email: EMAIL, tz: "UTC", from: "2026-11-02", days: 2, now });
    expect(load.days.map((d) => d.pages)).toEqual([1, 0]);
  });

  test("days before today are empty; a future range does not take overdue cards", async () => {
    note("2026-10-20T00:00:00.000Z");
    note("2026-11-05T05:00:00.000Z");
    const past = await dueLoad(d1, { email: EMAIL, tz: "UTC", from: "2026-11-01", days: 2, now });
    expect(past.days.map((d) => d.pages)).toEqual([0, 1]);
    const future = await dueLoad(d1, { email: EMAIL, tz: "UTC", from: "2026-11-05", days: 1, now });
    expect(future.days.map((d) => d.pages)).toEqual([1]);
  });

  test("a DST day keeps its 25 hours", async () => {
    const dst = new Date("2026-10-25T00:00:00Z");
    note("2026-10-25T22:30:00.000Z"); // 23:30 Berlin (CET, +1) on the 25th
    const load = await dueLoad(d1, {
      email: EMAIL,
      tz: "Europe/Berlin",
      from: "2026-10-25",
      days: 2,
      now: dst,
    });
    expect(load.days.map((d) => d.pages)).toEqual([1, 0]);
  });

  test("pace is the median measured word time, clamped", async () => {
    const ins = d1
      .raw()
      .prepare(
        `INSERT INTO word_reviews (email, list_id, term, rating, state, elapsed_ms, reviewed_at) VALUES (?, 'l1', ?, 3, 2, ?, ?)`,
      );
    for (let i = 0; i < 11; i++)
      ins.run(EMAIL, `t${i}`, 4000 + i * 100, "2026-11-01T00:00:00.000Z");
    const load = await dueLoad(d1, { email: EMAIL, tz: "UTC", from: "2026-11-02", days: 1, now });
    expect(load.pace.secondsPerWord).toBe(4.5);
  });
});
