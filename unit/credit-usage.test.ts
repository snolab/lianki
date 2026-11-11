import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  CSV_HEADER,
  FEATURES,
  GROUPS,
  buildEntries,
  dayParam,
  featureOf,
  filterEntries,
  groupOf,
  isGroup,
  localDay,
  localTime,
  monthTotals,
  safeZone,
  toCsv,
  usagePage,
  usageRows,
  type UsageRow,
} from "@/lib/payments/credit-usage";
import { creditUsage } from "@/lib/payments/credit-usage-handler";

let n = 0;
const row = (o: Partial<UsageRow> & Pick<UsageRow, "amount" | "reason">): UsageRow => ({
  id: `r${++n}`,
  refId: `ref${n}`,
  passId: null,
  note: null,
  createdAt: "2026-11-05T03:00:00.000Z",
  ...o,
});

describe("credit usage: rules", () => {
  it("names the feature of a row: an ai row's note, else a partner reply; other reasons themselves", () => {
    expect(featureOf({ reason: "ai", note: "read.gloss" })).toBe("read.gloss");
    expect(featureOf({ reason: "ai", note: null })).toBe("partner.reply");
    expect(featureOf({ reason: "ai", note: "  " })).toBe("partner.reply");
    expect(featureOf({ reason: "topup", note: "x" })).toBe("topup");
    expect(groupOf("words.tts")).toBe("voice");
    expect(groupOf("gift")).toBe("gift");
    expect(groupOf("something.new")).toBe("ai");
    expect(isGroup("voice")).toBe(true);
    expect(isGroup("nope")).toBe(false);
    for (const f of Object.values(FEATURES)) expect(GROUPS).toContain(f.group);
  });

  it("shows actual spend only: one net line per paid action, net-zero hidden, refunds linked", () => {
    const rows = [
      row({ amount: 600, reason: "topup", refId: "stripe:1", createdAt: "2026-11-01T00:00:00Z" }),
      row({ amount: -3, reason: "ai", refId: "ai:read.gloss:u:1", note: "read.gloss" }),
      row({ amount: -5, reason: "ai", refId: "ai:u:m1" }),
      row({ amount: 2, reason: "refund", refId: "ai:read.gloss:u:1" }),
      // A failed call: held, then all of it back — not shown at all.
      row({ amount: -4, reason: "ai", refId: "ai:words.tts:u:2", note: "words.tts" }),
      row({ amount: 4, reason: "refund", refId: "ai:words.tts:u:2" }),
      row({ amount: -600, reason: "pass", refId: "u:k", passId: "pro-1m" }),
      row({ amount: 600, reason: "refund", refId: "pass:u:k", passId: "pro-1m" }),
      row({ amount: -600, reason: "refund", refId: "topup:stripe:1" }),
      row({ amount: 5, reason: "refund", refId: "pass:unknown" }),
    ];
    const e = buildEntries(rows);
    expect(e.map((x) => x.reason)).toEqual([
      "topup",
      "ai",
      "ai",
      "pass",
      "refund",
      "refund",
      "refund",
    ]);
    // Net only: what the action really cost; no hold detail anywhere.
    expect(e[1]).toEqual({
      id: rows[1].id,
      at: rows[1].createdAt,
      reason: "ai",
      feature: "read.gloss",
      group: "gloss",
      amount: -1,
      balanceAfter: 594,
      passId: null,
      href: "/reader",
    });
    // Not settled yet: pending, the hold still taken.
    expect(e[2]).toMatchObject({
      feature: "partner.reply",
      amount: -5,
      balanceAfter: 592,
      pending: true,
    });
    expect(e.some((x) => x.feature === "words.tts")).toBe(false);
    expect(e[3]).toMatchObject({ reason: "pass", href: "/membership", balanceAfter: -6 });
    expect(e[4]).toMatchObject({
      group: "refund",
      amount: 600,
      balanceAfter: 594,
      href: null,
      refundOf: { id: rows[6].id, at: rows[6].createdAt, group: "pass" },
    });
    expect(e[5].refundOf).toEqual({ id: rows[0].id, at: rows[0].createdAt, group: "topup" });
    expect(e[6].refundOf).toBeUndefined();
    // Starting from a capped read's offset.
    expect(buildEntries(rows, 10).at(-1)?.balanceAfter).toBe(10 + 600 - 3 - 5 + 2 - 600 + 5);
  });

  it("keeps an orphan ai refund as its own line", () => {
    const e = buildEntries([row({ amount: 2, reason: "refund", refId: "ai:x" })]);
    expect(e[0]).toMatchObject({ reason: "refund", amount: 2, balanceAfter: 2 });
  });

  it("zones, days and the CSV", () => {
    expect(safeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(safeZone("Not/AZone")).toBe("UTC");
    expect(safeZone(42)).toBe("UTC");
    expect(safeZone("")).toBe("UTC");
    expect(localDay("2026-11-05T16:00:00Z", "Asia/Tokyo")).toBe("2026-11-06");
    expect(localDay("2026-11-05T16:00:00Z", "UTC")).toBe("2026-11-05");
    expect(localTime("2026-11-05T16:05:00Z", "Asia/Tokyo")).toBe("2026-11-06 01:05");
    expect(dayParam("2026-11-06")).toBe("2026-11-06");
    expect(dayParam("11/6/2026")).toBeNull();
    expect(dayParam(undefined)).toBeNull();

    const e = buildEntries([
      row({ amount: 600, reason: "topup", createdAt: "2026-11-05T16:05:00Z" }),
      row({ amount: -2, reason: "ai", refId: "ai:k", note: '=cmd,"x"' }),
      row({ amount: 1, reason: "refund", refId: "ai:k" }),
      row({ amount: -600, reason: "pass", passId: "pro-1m" }),
    ]);
    const csv = toCsv(e, "Asia/Tokyo").split("\r\n");
    expect(csv[0]).toBe(CSV_HEADER.join(","));
    expect(csv[1]).toBe("2026-11-05T16:05:00Z,2026-11-06 01:05,topup,topup,600,,600,,");
    // A formula-looking or quoted value is defused and quoted; one row, the net amount.
    expect(csv[2]).toContain(`"'=cmd,""x"""`);
    expect(csv[2]).toEndWith(",ai,-1,,599,,");
    expect(csv[3]).toEndWith(",-600,,-1,pro-1m,");
    expect(csv.at(-1)).toBe("");
    expect(csv.join("\n")).not.toMatch(/held|refunded|actual/);
    const pending = toCsv(buildEntries([row({ amount: -2, reason: "ai", refId: "ai:p" })]), "UTC");
    expect(pending).toContain(",ai,-2,pending,-2,,");
  });

  it("filters by group and local day range; month totals in the zone", () => {
    const e = buildEntries([
      row({ amount: 600, reason: "topup", createdAt: "2026-10-31T16:00:00Z" }), // JST 11-01
      row({ amount: -3, reason: "ai", note: "words.tts", createdAt: "2026-10-31T14:00:00Z" }), // JST 10-31
      row({ amount: -4, reason: "ai", note: "words.tts", createdAt: "2026-11-03T00:00:00Z" }),
      row({ amount: -1, reason: "ai", note: "read.gloss", createdAt: "2026-11-04T00:00:00Z" }),
      row({ amount: 50, reason: "gift", createdAt: "2026-11-04T00:00:00Z" }),
    ]);
    const tz = "Asia/Tokyo";
    expect(filterEntries(e, { group: "voice", tz })).toHaveLength(2);
    expect(filterEntries(e, { from: "2026-11-01", tz })).toHaveLength(4);
    expect(filterEntries(e, { to: "2026-11-01", tz })).toHaveLength(2);
    expect(filterEntries(e, { from: "2026-11-02", to: "2026-11-03", tz })).toHaveLength(1);
    expect(filterEntries(e, { tz })).toHaveLength(5);
    const m = monthTotals(e, tz, new Date("2026-11-09T00:00:00Z"));
    expect(m).toEqual([
      { group: "voice", spent: 4, added: 0, count: 1 },
      { group: "gloss", spent: 1, added: 0, count: 1 },
      { group: "topup", spent: 0, added: 600, count: 1 },
      { group: "gift", spent: 0, added: 50, count: 1 },
    ]);
  });

  it("pages newest first, ends on the cached balance, lists only present groups", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({
        amount: -1,
        reason: "ai",
        note: "speech.stt",
        createdAt: `2026-11-0${i + 1}T00:00:00Z`,
      }),
    );
    const q = new URLSearchParams({ tz: "UTC", limit: "2", offset: "1", group: "stt" });
    const p = usagePage(rows, 95, q, new Date("2026-11-09T00:00:00Z"));
    expect(p.tz).toBe("UTC");
    expect(p.total).toBe(5);
    expect(p.entries.map((e) => e.at)).toEqual(["2026-11-04T00:00:00Z", "2026-11-03T00:00:00Z"]);
    // 95 now and 5 spent: the first line left 99.
    expect(p.entries[0].balanceAfter).toBe(96);
    expect(p.balance).toBe(95);
    expect(p.groups).toEqual(["stt"]);
    expect(p.month[0]).toMatchObject({ group: "stt", spent: 5 });
    // Bad paging falls back; `all` ignores it; a bad group is no filter.
    const all = usagePage(
      rows,
      95,
      new URLSearchParams({ limit: "x", group: "bogus" }),
      undefined,
      {
        all: true,
      },
    );
    expect(all.entries).toHaveLength(5);
    expect(usagePage(rows, 95, new URLSearchParams({ limit: "9999" })).entries).toHaveLength(5);
  });
});

describe("credit usage: D1 and the route", () => {
  let d1: TestD1Database;
  const db = () => d1 as unknown as D1Like;
  const NOW = () => new Date("2026-11-09T00:00:00Z");
  const req = (q = "") => new Request(`https://lianki.test/api/payments/credits/usage${q}`);
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.raw().exec(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES
      ('u_a', 'a@x.com', 'x', 'x'), ('u_b', 'b@x.com', 'x', 'x')`);
    d1.raw()
      .exec(`INSERT INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt) VALUES
      ('1', 'u_a', 600, 'topup', 'stripe:1', NULL, NULL, '2026-11-01T00:00:00Z'),
      ('2', 'u_a', -3, 'ai', 'ai:read.gloss:u_a:1', NULL, 'read.gloss', '2026-11-02T00:00:00Z'),
      ('3', 'u_a', 2, 'refund', 'ai:read.gloss:u_a:1', NULL, NULL, '2026-11-02T00:00:00Z'),
      ('4', 'u_b', 900, 'gift', 'g:u_b', NULL, NULL, '2026-11-03T00:00:00Z')`);
    d1.raw().exec(`INSERT INTO credit_balance (userId, balance, updatedAt) VALUES
      ('u_a', 599, 'x'), ('u_b', 900, 'x')`);
  });

  it("reads only the user's own rows, in written order, capped to the newest", async () => {
    const rows = await usageRows(db(), "u_a");
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect((await usageRows(db(), "u_a", 2)).map((r) => r.id)).toEqual(["2", "3"]);
    expect(await usageRows(db(), "nobody")).toEqual([]);
  });

  it("answers 503 off D1 and 401 signed out", async () => {
    expect((await creditUsage(req(), { userId: "u_a", d1: null })).status).toBe(503);
    expect((await creditUsage(req(), { userId: null, d1: db() })).status).toBe(401);
  });

  it("answers the signed-in user's page, never another's", async () => {
    const res = await creditUsage(req("?tz=Asia/Tokyo&userId=u_b"), {
      userId: "u_a",
      d1: db(),
      now: NOW,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { balance: number; entries: { id: string }[] };
    expect(body.balance).toBe(599);
    expect(body.entries.map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("exports the user's own lines as CSV, oldest first", async () => {
    const res = await creditUsage(req("?format=csv&tz=Asia/Tokyo"), {
      userId: "u_a",
      d1: db(),
      now: NOW,
    });
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("lianki-credits-2026-11-09.csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",topup,topup,600,");
    expect(lines[2]).toContain(",read.gloss,ai,-1,,599,,");
    expect(lines.join("\n")).not.toContain("gift");
    // Default `now`.
    expect((await creditUsage(req(), { userId: "u_a", d1: db() })).status).toBe(200);
  });
});
