import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import {
  crossedStep,
  paidUsdMicro,
  recordSpend,
  spendLine,
  spendWindows,
  stepMicro,
  stepText,
  usdText,
} from "@/lib/payments/spend-alert";
import {
  SPEND_ALERT_FLAG,
  SPEND_ALERT_PATH,
  SPEND_MINE_TEXT,
  SPEND_SITE_TEXT,
  SPEND_LINE_MAX,
  parseSpendNotice,
} from "@/lib/payments/spend-alert-config";
import { bookCost } from "@/lib/payments/cost-ledger";
import { reserveAi, settleAi } from "@/lib/payments/ai-credits";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { MARGIN } from "@/lib/payments/prices";
import { CONFIG, parseStoredConfig } from "@/lib/config";
import { FLAGS } from "@/lib/flags";

const USD = 1e6;

describe("spend alert: the step arithmetic", () => {
  it("crossedStep: the highest whole step reached above the last one, else null", () => {
    expect(crossedStep(0, 0.99 * USD, USD)).toBeNull();
    expect(crossedStep(0, USD, USD)).toBe(USD);
    expect(crossedStep(0, 1.2 * USD, USD)).toBe(USD);
    expect(crossedStep(USD, 1.99 * USD, USD)).toBeNull();
    // Several steps at once: one, the highest.
    expect(crossedStep(USD, 4.5 * USD, USD)).toBe(4 * USD);
    // A sum of REAL millionths just under a whole step still counts.
    expect(crossedStep(0, 0.1 * 3 * USD + 0.7 * USD, USD)).toBe(USD);
    expect(crossedStep(0, 0.30000000000000004 * USD, 0.1 * USD)).toBe(0.3 * USD);
  });

  it("crossedStep: a changed step size never repeats an amount already announced", () => {
    // $3 announced at $1 steps; the owner moves to $5 steps: nothing until $5.
    expect(crossedStep(3 * USD, 4.9 * USD, 5 * USD)).toBeNull();
    expect(crossedStep(3 * USD, 5 * USD, 5 * USD)).toBe(5 * USD);
    // Down to $0.5 steps: the next is $3.5, never $3 again.
    expect(crossedStep(3 * USD, 3.2 * USD, 0.5 * USD)).toBeNull();
    expect(crossedStep(3 * USD, 3.5 * USD, 0.5 * USD)).toBe(3.5 * USD);
  });

  it("crossedStep: junk in, nothing out", () => {
    expect(crossedStep(0, 5 * USD, 0)).toBeNull();
    expect(crossedStep(0, 5 * USD, -1)).toBeNull();
    expect(crossedStep(0, Number.NaN, USD)).toBeNull();
    expect(crossedStep(Number.NaN, 5 * USD, USD)).toBeNull();
    expect(crossedStep(0, -2 * USD, USD)).toBeNull();
  });

  it("stepMicro clamps to the config range; junk is the default $1", () => {
    expect(stepMicro(1)).toBe(USD);
    expect(stepMicro(0.5)).toBe(0.5 * USD);
    expect(stepMicro(0.01)).toBe(0.1 * USD);
    expect(stepMicro(1000)).toBe(100 * USD);
    expect(stepMicro("2")).toBe(USD);
    expect(stepMicro(Number.NaN)).toBe(USD);
    expect(stepMicro(undefined)).toBe(USD);
  });

  it("the line: {n} as a short amount, {today} and {month} with cents, every occurrence", () => {
    expect(stepText(3 * USD)).toBe("3");
    expect(stepText(1.5 * USD)).toBe("1.5");
    expect(usdText(0.4249 * USD)).toBe("0.42");
    expect(usdText(-1)).toBe("0.00");
    expect(spendLine(SPEND_SITE_TEXT, { n: 3 * USD, today: 0.42 * USD, month: 3 * USD })).toBe(
      "AI 全站花费已达 $3（今日 $0.42，本月 $3.00）",
    );
    expect(spendLine(SPEND_MINE_TEXT, { n: USD, today: 0.1 * USD, month: 1.2 * USD })).toBe(
      "我的 AI 花费已达 $1（今日 $0.10，本月 $1.20）",
    );
    expect(spendLine("{n}/{n}", { n: 2 * USD, today: 0, month: 0 })).toBe("2/2");
  });

  it("spendWindows: today and this month in UTC, the day index a day wider", () => {
    const w = spendWindows(new Date("2026-11-15T23:30:00Z"));
    expect(w.today).toEqual({
      startIso: "2026-11-15T00:00:00.000Z",
      endIso: "2026-11-16T00:00:00.000Z",
      fromDay: "2026-11-14",
      toDay: "2026-11-17",
    });
    expect(w.month.startIso).toBe("2026-11-01T00:00:00.000Z");
    expect(w.month.fromDay).toBe("2026-10-31");
    expect(w.month.endIso).toBe("2026-11-16T00:00:00.000Z");
  });

  it("paidUsdMicro: a settled charge's provider cost", () => {
    expect(paidUsdMicro(CREDITS_PER_USD * MARGIN * USD)).toBeCloseTo(USD, 6);
  });

  it("parseSpendNotice: only {scope, step, text}, bounded", () => {
    expect(parseSpendNotice({ scope: "site", step: 1, text: " hi " })).toEqual({
      scope: "site",
      step: 1,
      text: "hi",
    });
    expect(parseSpendNotice({ scope: "mine", step: 2.5, text: "x" })?.scope).toBe("mine");
    for (const bad of [
      null,
      "x",
      { scope: "user:u1", step: 1, text: "x" },
      { scope: "site", step: 0, text: "x" },
      { scope: "site", step: Number.NaN, text: "x" },
      { scope: "site", step: "1", text: "x" },
      { scope: "site", step: 1, text: "  " },
      { scope: "site", step: 1, text: 3 },
      { scope: "site", step: 1, text: "x".repeat(SPEND_LINE_MAX + 1) },
    ])
      expect(parseSpendNotice(bad)).toBeNull();
  });
});

describe("spend alert: registry", () => {
  it("flag partner.spend-alert: default on, owner audience, in the ai group", () => {
    const f = FLAGS[SPEND_ALERT_FLAG];
    expect(f.default).toBe(true);
    expect(f.audience).toBe("owner");
    expect(f.group).toBe("ai");
  });

  it("config: the step ($1, 0.1–100) and both lines, server-only, each needing {n}", () => {
    const step = CONFIG["partner.spendAlertStepUsd"];
    expect(step.default).toBe(1);
    expect(step.min).toBe(0.1);
    expect(step.max).toBe(100);
    expect(step.audience).toBe("server");
    expect(parseStoredConfig("partner.spendAlertStepUsd", "0.05")).toBeUndefined();
    expect(parseStoredConfig("partner.spendAlertStepUsd", "0.5")).toBe(0.5);
    expect(CONFIG["partner.spendAlertSiteText"].default).toBe(SPEND_SITE_TEXT);
    expect(CONFIG["partner.spendAlertMineText"].default).toBe(SPEND_MINE_TEXT);
    expect(parseStoredConfig("partner.spendAlertSiteText", '"no amount"')).toBeUndefined();
    expect(parseStoredConfig("partner.spendAlertMineText", '"花了 ${n}"')).toBe("花了 ${n}");
  });
});

describe("spend alert: the counters in D1", () => {
  let d1: TestD1Database;
  const NOW = new Date("2026-11-15T06:00:00Z");
  type Sent = { url: string; body: { scope: string; step: number; text: string } };
  let sent: Sent[];
  let status: number;
  const push = {
    fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status });
    },
  };
  const logs: Record<string, unknown>[] = [];
  const deps = { push, now: NOW, log: (o: Record<string, unknown>) => void logs.push(o) };
  const row = (scope: string) =>
    (d1
      .raw()
      .prepare("SELECT total_micro, last_micro FROM spend_alert WHERE scope = ?")
      .get(scope) ?? null) as { total_micro: number; last_micro: number } | null;
  const setFlag = (on: boolean) =>
    d1
      .raw()
      .exec(
        `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('${SPEND_ALERT_FLAG}', ${on ? 1 : 0}, 0, 'owner') ON CONFLICT(key) DO UPDATE SET enabled = ${on ? 1 : 0}`,
      );
  const setConfig = (key: string, v: unknown) =>
    d1
      .raw()
      .prepare(
        "INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES (?, ?, 1, 'test') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(key, JSON.stringify(v));

  beforeEach(() => {
    d1 = createTestD1(testSchema());
    sent = [];
    status = 200;
    logs.length = 0;
    const raw = d1.raw();
    for (const [id, email] of [
      ["u_owner", "owner@test.example"],
      ["u_alice", "alice@test.example"],
    ])
      raw
        .prepare(
          "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
        )
        .run(id, email);
    raw.exec(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES ('owner@test.example', 'dev', 'test', 1)",
    );
  });

  it("the site counter: one line at $1, none below it, none again for the same step", async () => {
    expect(await recordSpend(d1, null, 0.6 * USD, deps)).toEqual([]);
    expect(sent).toEqual([]);
    const posted = await recordSpend(d1, null, 0.5 * USD, deps);
    expect(posted).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://lianki-push${SPEND_ALERT_PATH}`);
    expect(sent[0].body).toMatchObject({ scope: "site", step: 1 });
    // The day's and month's totals come from the ledger (empty here: this call booked nothing).
    expect(sent[0].body.text).toBe("AI 全站花费已达 $1（今日 $0.00，本月 $0.00）");
    await recordSpend(d1, null, 0.5 * USD, deps);
    expect(sent).toHaveLength(1);
    expect(row("site")).toEqual({ total_micro: 1.6 * USD, last_micro: USD });
    await recordSpend(d1, null, 2 * USD, deps);
    expect(sent.map((s) => s.body.step)).toEqual([1, 3]);
  });

  it("nothing for no cost, no DB or a junk amount", async () => {
    expect(await recordSpend(null, "u_owner", USD, deps)).toEqual([]);
    expect(await recordSpend(d1, "u_owner", 0, deps)).toEqual([]);
    expect(await recordSpend(d1, "u_owner", Number.POSITIVE_INFINITY, deps)).toEqual([]);
    expect(row("site")).toBeNull();
  });

  it("many calls crossing one step together: one line", async () => {
    await recordSpend(d1, null, 0.9 * USD, deps);
    await Promise.all(Array.from({ length: 5 }, () => recordSpend(d1, null, 0.1 * USD, deps)));
    expect(sent).toHaveLength(1);
    expect(row("site")?.last_micro).toBe(USD);
  });

  it("his own account: a 'mine' line too; anyone else's counter claims silently", async () => {
    await recordSpend(d1, "u_owner", 1.2 * USD, deps);
    expect(sent.map((s) => s.body.scope)).toEqual(["site", "mine"]);
    expect(sent[1].body.text).toBe("我的 AI 花费已达 $1（今日 $0.00，本月 $0.00）");
    sent = [];
    await recordSpend(d1, "u_alice", 1.2 * USD, deps);
    // The site passed $2; Alice's own $1 is never posted.
    expect(sent.map((s) => [s.body.scope, s.body.step])).toEqual([["site", 2]]);
    expect(row("user:u_alice")?.last_micro).toBe(USD);
    // A revoked grant: no longer his line.
    d1.raw().exec("UPDATE account_permission SET revoked_at = 2");
    sent = [];
    await recordSpend(d1, "u_owner", USD, deps);
    expect(sent.map((s) => s.body.scope)).toEqual(["site"]);
  });

  it("admin counts as the owner too", async () => {
    d1.raw().exec(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES ('alice@test.example', 'admin', 'test', 1)",
    );
    await recordSpend(d1, "u_alice", USD, deps);
    expect(sent.map((s) => s.body.scope)).toEqual(["site", "mine"]);
  });

  it("flag off: the step passes silently and is never posted later", async () => {
    setFlag(false);
    await recordSpend(d1, null, 1.5 * USD, deps);
    expect(sent).toEqual([]);
    expect(row("site")?.last_micro).toBe(USD);
    setFlag(true);
    await recordSpend(d1, null, 0.1 * USD, deps);
    expect(sent).toEqual([]);
    await recordSpend(d1, null, 0.5 * USD, deps);
    expect(sent.map((s) => s.body.step)).toEqual([2]);
  });

  it("nowhere to post (no binding): the step waits for a call that can", async () => {
    await recordSpend(d1, null, 1.5 * USD, { ...deps, push: null });
    expect(row("site")).toEqual({ total_micro: 1.5 * USD, last_micro: 0 });
    // Off the Worker the default binding is none either.
    await recordSpend(d1, null, 0.1 * USD, { now: NOW, log: deps.log });
    expect(row("site")?.last_micro).toBe(0);
    await recordSpend(d1, null, 0.1 * USD, deps);
    expect(sent.map((s) => s.body.step)).toEqual([1]);
  });

  it("a failed post gives the step back; the next call posts it", async () => {
    status = 503;
    await recordSpend(d1, null, 1.5 * USD, deps);
    expect(sent).toHaveLength(1);
    expect(row("site")?.last_micro).toBe(0);
    expect(logs.at(-1)).toMatchObject({ event: "spend.alert.failed", scope: "site", step: 1 });
    status = 200;
    await recordSpend(d1, null, 0.1 * USD, deps);
    expect(sent).toHaveLength(2);
    expect(row("site")?.last_micro).toBe(USD);
  });

  it("a give-back that fails too is swallowed (the step is then skipped, never doubled)", async () => {
    status = 503;
    const flaky = {
      prepare: (q: string) => {
        if (q.includes("AND last_micro = ?")) throw new Error("d1 down");
        return d1.prepare(q);
      },
      exec: (q: string) => d1.exec(q),
    };
    expect(await recordSpend(flaky, null, 1.5 * USD, deps)).toEqual([]);
    expect(row("site")?.last_micro).toBe(USD);
  });

  it("a throwing binding is caught and logged; recordSpend never throws", async () => {
    const bad = {
      fetch: async () => {
        throw new Error("binding down");
      },
    };
    expect(await recordSpend(d1, "u_owner", 2 * USD, { ...deps, push: bad })).toEqual([]);
    expect(logs.filter((l) => l.event === "spend.alert.failed")).toHaveLength(2);
    expect(row("site")?.last_micro).toBe(0);
    // No table (an older schema): logged, nothing thrown.
    const old = createTestD1("CREATE TABLE x (a INT);");
    expect(await recordSpend(old, null, USD, deps)).toEqual([]);
  });

  it("the step size and the text come from /dev/config", async () => {
    setConfig("partner.spendAlertStepUsd", 0.5);
    setConfig("partner.spendAlertSiteText", "站点 ${n} / {today} / {month}");
    await recordSpend(d1, null, 0.6 * USD, deps);
    expect(sent.map((s) => s.body.text)).toEqual(["站点 $0.5 / 0.00 / 0.00"]);
  });

  it("bookCost feeds it, and the line carries today's and the month's ledger totals", async () => {
    // Earlier this month (UTC), and yesterday in JST-dated rows: month only.
    d1.raw().exec(
      `INSERT INTO cost_ledger (user_id, feature, usd_micro, units, day, at) VALUES ('u_alice', 'words.tts', ${2 * USD}, 0, '2026-11-03', '2026-11-03T05:00:00.000Z')`,
    );
    // Last month: neither.
    d1.raw().exec(
      `INSERT INTO cost_ledger (user_id, feature, usd_micro, units, day, at) VALUES ('u_owner', 'words.tts', ${5 * USD}, 0, '2026-10-31', '2026-10-31T23:00:00.000Z')`,
    );
    expect(
      await bookCost(
        d1,
        { userId: "u_owner", feature: "speech.stt", usd: 1.25 },
        NOW,
        deps.log,
        push,
      ),
    ).toBe(true);
    expect(sent.map((s) => s.body.text)).toEqual([
      "AI 全站花费已达 $1（今日 $1.25，本月 $3.25）",
      "我的 AI 花费已达 $1（今日 $1.25，本月 $1.25）",
    ]);
  });

  it("a failed booking adds nothing", async () => {
    const old = createTestD1("CREATE TABLE x (a INT);");
    expect(
      await bookCost(
        old,
        { userId: "u_owner", feature: "speech.stt", usd: 5 },
        NOW,
        deps.log,
        push,
      ),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it("settleAi feeds it at the provider's cost (paid charges count in the totals too)", async () => {
    const db = d1 as unknown as D1WithBatch;
    d1.raw().exec(
      "INSERT INTO credit_balance (userId, balance, updatedAt) VALUES ('u_owner', 1000, 'x')",
    );
    const r = await reserveAi(db, { userId: "u_owner", key: "u_owner:m1", reserved: 500 }, NOW);
    expect(r.status).toBe("reserved");
    // $1.20 of provider cost = 1.2 × 150 × 1.5 credits, in millionths of a credit.
    const costMicro = 1.2 * CREDITS_PER_USD * MARGIN * USD;
    await settleAi(db, "u_owner:m1", costMicro, NOW, { push, log: deps.log });
    expect(sent.map((s) => s.body.text)).toEqual([
      "AI 全站花费已达 $1（今日 $1.20，本月 $1.20）",
      "我的 AI 花费已达 $1（今日 $1.20，本月 $1.20）",
    ]);
    expect(row("site")?.total_micro).toBeCloseTo(1.2 * USD, 3);
    // Settled at no cost (a sweep): nothing added.
    await reserveAi(db, { userId: "u_owner", key: "u_owner:m2", reserved: 10 }, NOW);
    await settleAi(db, "u_owner:m2", 0, NOW, { push });
    expect(row("site")?.total_micro).toBeCloseTo(1.2 * USD, 3);
  });
});
