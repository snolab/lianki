import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { FLAG_KEYS, FLAGS, PREREQ_REASONS, type FlagDef, type PrereqCheck } from "@/lib/flags";
import { loadFlags, setFlag, type D1WithBatch } from "@/lib/flags-store";
import {
  allFailedPrereqs,
  changeFlag,
  CHECKS,
  failedPrereqs,
  type PrereqContext,
} from "@/lib/flag-prereqs";
import { FlagCard, MONEY_NOTE } from "@/app/(app)/dev/flags/FlagsAdmin";

/**
 * Flag prerequisites (docs/feature-flags.md, "Prerequisites"). What matters: a
 * flag whose prerequisites fail cannot be turned ON through the API, can always
 * be turned OFF (the kill switch), /dev/flags shows why, and no check ever
 * returns, logs or renders a setting's value.
 */
const BY = "owner@x.com";
const NOW = new Date("2026-11-05T05:00:00.000Z");

// Fake but well-formed values; each must never show up in any output below.
const SECRETS = {
  KOMOJU_SECRET_KEY: "sk_live_KOMOJUSECRETVALUE123",
  KOMOJU_WEBHOOK_SECRET: "whsec_KOMOJUHOOKVALUE456",
  STRIPE_SECRET_KEY: "sk_live_STRIPESECRETVALUE789",
  STRIPE_WEBHOOK_SECRET: "whsec_STRIPEHOOKVALUE012",
  CLOUDFLARE_ACCOUNT_ID: "acct0000ACCOUNTVALUE345",
  CLOUDFLARE_AI_TOKEN: "cfai_TOKENVALUE678",
  AUTH_GOOGLE_ID: "123456789-GOOGLEIDVALUE.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: "GOCSPX-GOOGLESECRETVALUE901",
  GOOGLE_PICKER_API_KEY: "AIzaPICKERKEYVALUE234567890",
  AUTH_SECRET: "AUTHSECRETVALUE-0123456789abcdef0123456789",
};

const db = () => createTestD1(testSchema()) as unknown as D1WithBatch;
const ctx = (env: Record<string, string | undefined>, d1: D1Like | null): PrereqContext => ({
  env,
  d1,
});

describe("declared prerequisites", () => {
  test("every declared check exists and every reason carries a context line", () => {
    for (const k of FLAG_KEYS)
      for (const c of (FLAGS[k] as FlagDef).requires ?? []) expect(CHECKS[c]).toBeFunction();
    for (const [, r] of Object.entries(PREREQ_REASONS)) {
      expect(r.zh.length).toBeGreaterThan(0);
      expect(r.context.split(/\s+/).length).toBeGreaterThanOrEqual(5);
    }
  });

  test("the flags that need something declare it", () => {
    const req = (k: keyof typeof FLAGS) => (FLAGS[k] as FlagDef).requires ?? [];
    expect(req("payments.komoju.live")).toEqual(["komoju.live-key"]);
    expect(req("payments.stripe.live")).toEqual(["stripe.live-key"]);
    expect(req("partner.ai-reply")).toEqual(["workers-ai.credentials", "ai-credits.migration"]);
    expect(req("connections.google")).toEqual([
      "google.oauth-client",
      "google.picker-key",
      "auth-secret",
    ]);
    expect(req("words.voice-mode")).toEqual([]);
  });
});

describe("checks", () => {
  test("payments: only a live key with its webhook secret passes", async () => {
    const d1 = db();
    expect(await failedPrereqs("payments.komoju.live", ctx({}, d1))).toMatchObject([
      { reason: "komoju.no-live-key" },
    ]);
    const test = { KOMOJU_SECRET_KEY: "sk_test_x", KOMOJU_WEBHOOK_SECRET: "w" };
    expect(await failedPrereqs("payments.komoju.live", ctx(test, d1))).toHaveLength(1);
    const noHook = { KOMOJU_SECRET_KEY: SECRETS.KOMOJU_SECRET_KEY };
    expect(await failedPrereqs("payments.komoju.live", ctx(noHook, d1))).toHaveLength(1);
    expect(await failedPrereqs("payments.komoju.live", ctx(SECRETS, d1))).toEqual([]);
    expect(await failedPrereqs("payments.stripe.live", ctx({}, d1))).toMatchObject([
      { reason: "stripe.no-live-key" },
    ]);
    expect(await failedPrereqs("payments.stripe.live", ctx(SECRETS, d1))).toEqual([]);
  });

  test("partner.ai-reply: Workers AI settings and the credits migration", async () => {
    const d1 = db();
    expect((await failedPrereqs("partner.ai-reply", ctx({}, d1))).map((r) => r.reason)).toEqual([
      "workers-ai.no-credentials",
    ]);
    expect(await failedPrereqs("partner.ai-reply", ctx(SECRETS, d1))).toEqual([]);
    const apiToken = { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" };
    expect(await failedPrereqs("partner.ai-reply", ctx(apiToken, d1))).toEqual([]);
    // Without migration 0041 (or without D1 at all), fail closed.
    const old = createTestD1(
      "CREATE TABLE credit_ledger (id TEXT, reason TEXT CHECK (reason IN ('topup')));",
    ) as unknown as D1Like;
    expect(
      (await failedPrereqs("partner.ai-reply", ctx(SECRETS, old))).map((r) => r.reason),
    ).toEqual(["ai-credits.no-migration"]);
    expect(
      (await failedPrereqs("partner.ai-reply", ctx(SECRETS, null))).map((r) => r.reason),
    ).toEqual(["ai-credits.no-migration"]);
  });

  test("connections.google: OAuth client, Picker key, AUTH_SECRET", async () => {
    const d1 = db();
    expect((await failedPrereqs("connections.google", ctx({}, d1))).map((r) => r.reason)).toEqual([
      "google.no-oauth-client",
      "google.no-picker-key",
      "auth.no-secret",
    ]);
    expect(
      (
        await failedPrereqs("connections.google", ctx({ ...SECRETS, AUTH_SECRET: "short" }, d1))
      ).map((r) => r.reason),
    ).toEqual(["auth.no-secret"]);
    expect(await failedPrereqs("connections.google", ctx(SECRETS, d1))).toEqual([]);
  });
});

describe("the API's change", () => {
  test("an unmet prerequisite refuses ON, with the reason, and writes nothing", async () => {
    const d1 = db();
    const r = await changeFlag(d1, { key: "payments.komoju.live", enabled: true }, BY, ctx({}, d1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(PREREQ_REASONS["komoju.no-live-key"].zh);
    expect(r.reasons?.map((x) => x.reason)).toEqual(["komoju.no-live-key"]);
    expect((await loadFlags(d1))["payments.komoju.live"]).toBe(false);
  });

  test("OFF always works, prerequisites or not (the kill switch)", async () => {
    const d1 = db();
    // On from before the check existed, and the key is gone since.
    await setFlag(d1, "payments.komoju.live", true, BY, NOW);
    expect(
      await changeFlag(d1, { key: "payments.komoju.live", enabled: false }, BY, ctx({}, null)),
    ).toEqual({ ok: true });
    expect((await loadFlags(d1))["payments.komoju.live"]).toBe(false);
  });

  test("met prerequisites, and flags with none, turn on; bad input is still refused", async () => {
    const d1 = db();
    expect(
      await changeFlag(d1, { key: "payments.komoju.live", enabled: true }, BY, ctx(SECRETS, d1)),
    ).toEqual({ ok: true });
    expect(
      await changeFlag(d1, { key: "words.voice-mode", enabled: true }, BY, ctx({}, null)),
    ).toEqual({ ok: true });
    const flags = await loadFlags(d1);
    expect(flags["payments.komoju.live"]).toBe(true);
    expect(flags["words.voice-mode"]).toBe(true);
    expect(await changeFlag(d1, { key: "nope", enabled: true }, BY, ctx({}, d1))).toMatchObject({
      ok: false,
    });
    expect(
      await changeFlag(d1, { key: "words.voice-mode", enabled: "yes" }, BY, ctx({}, d1)),
    ).toMatchObject({ ok: false });
  });
});

describe("/dev/flags card", () => {
  const row = (key: keyof typeof FLAGS, enabled: boolean) => ({
    key,
    description: FLAGS[key].description,
    enabled,
    updatedAt: null,
    updatedBy: null,
  });
  const html = (el: Parameters<typeof FlagCard>[0]) => renderToString(createElement(FlagCard, el));

  test("an unmet prerequisite greys the switch and shows the reason", async () => {
    const failed = await failedPrereqs("payments.komoju.live", ctx({}, null));
    const out = html({
      flag: row("payments.komoju.live", false),
      failed,
      busy: false,
      onToggle() {},
    });
    expect(out).toContain(PREREQ_REASONS["komoju.no-live-key"].zh);
    expect(out).toMatch(/role="switch"[^>]*disabled=""/);
    expect(out).toContain(MONEY_NOTE);
  });

  test("a flag that is on stays switchable off even when its prerequisites fail", async () => {
    const failed = await failedPrereqs("payments.komoju.live", ctx({}, null));
    const out = html({
      flag: row("payments.komoju.live", true),
      failed,
      busy: false,
      onToggle() {},
    });
    expect(out).toContain(PREREQ_REASONS["komoju.no-live-key"].zh);
    expect(out).not.toMatch(/role="switch"[^>]*disabled=""/);
  });

  test("a flag with no failing prerequisite is plain; no money note off payments", () => {
    const out = html({ flag: row("words.voice-mode", false), busy: false, onToggle() {} });
    expect(out).not.toMatch(/disabled=""/);
    expect(out).not.toContain(MONEY_NOTE);
  });
});

describe("never exposes a value", () => {
  test("results, refusals, logs and the page carry no setting's value", async () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const d1 = db();
      // Half-configured: values present but not enough to pass, so every
      // failure path runs with secrets in the env.
      const half = {
        ...SECRETS,
        KOMOJU_SECRET_KEY: "sk_test_KOMOJUTESTVALUE999",
        STRIPE_WEBHOOK_SECRET: undefined,
        CLOUDFLARE_ACCOUNT_ID: undefined,
        GOOGLE_PICKER_API_KEY: "bad",
        AUTH_SECRET: "SHORTAUTHVALUE",
      };
      const all = await allFailedPrereqs(ctx(half, d1));
      const outputs: unknown[] = [all];
      for (const key of FLAG_KEYS)
        outputs.push(await changeFlag(d1, { key, enabled: true }, BY, ctx(half, d1)));
      for (const key of FLAG_KEYS)
        outputs.push(html({ flag: row(key, false), failed: all[key], busy: false, onToggle() {} }));
      const text = JSON.stringify(outputs) + logged.join("\n");
      for (const v of [...Object.values(SECRETS), ...Object.values(half)])
        if (v && v.length > 5) expect(text).not.toContain(v);
      for (const c of Object.keys(CHECKS) as PrereqCheck[]) {
        const r = await CHECKS[c](ctx(SECRETS, d1));
        expect(Object.keys(r).sort()).toEqual(["ok"]);
      }
    } finally {
      console.log = orig;
    }
  });

  function row(key: keyof typeof FLAGS, enabled: boolean) {
    return { key, description: FLAGS[key].description, enabled, updatedAt: null, updatedBy: null };
  }
  function html(el: Parameters<typeof FlagCard>[0]) {
    return renderToString(createElement(FlagCard, el));
  }
});

describe("wiring", () => {
  test("POST /api/dev/flags goes through changeFlag, never setFlag directly", async () => {
    const src = await Bun.file("app/api/dev/flags/route.ts").text();
    expect(src).toContain("changeFlag(");
    expect(src).not.toMatch(/\bsetFlag\(/);
    expect(src).toContain("allFailedPrereqs(");
  });
});
