/**
 * Prerequisite checks for feature flags (`requires` in lib/flags.ts). A flag
 * whose checks fail cannot be turned ON — the API answers 400 with the reason
 * and /dev/flags greys its switch — while turning it OFF always works (the
 * kill switch). docs/feature-flags.md, "Prerequisites".
 *
 * Every check reads only whether a setting is present and in the right format
 * (e.g. the key's `sk_live_` prefix), or whether a migration's table exists in
 * D1. A secret's value is never returned, logged or compared to anything but
 * its own format. Server only.
 */
import type { D1Like } from "@/lib/d1/types";
import { pickerConfig } from "@/lib/connections/google";
import { komojuKeyMode } from "@/lib/payments/providers/komoju";
import { stripeKeyMode } from "@/lib/payments/stripe";
import { FlagError, setFlag, type D1WithBatch } from "./flags-store";
import {
  FLAGS,
  isFlagKey,
  PREREQ_REASONS,
  type FlagDef,
  type FlagKey,
  type PrereqCheck,
  type PrereqReason,
} from "./flags";

type Env = Record<string, string | undefined>;

export interface PrereqContext {
  env: Env;
  /** D1, for checks that a migration ran; null fails those checks (closed). */
  d1: D1Like | null;
}

export type CheckResult = { ok: true } | { ok: false; reason: PrereqReason };

const set = (v: string | undefined) => !!v?.trim();
const pass: CheckResult = { ok: true };
const fail = (reason: PrereqReason): CheckResult => ({ ok: false, reason });

/** Every table in D1 whose name is one of `names`, with its CREATE statement. */
async function tables(d1: D1Like, names: string[]): Promise<Map<string, string>> {
  const { results } = await d1
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(", ")})`,
    )
    .bind(...names)
    .all<{ name: string; sql: string | null }>();
  return new Map(results.map((r) => [r.name, r.sql ?? ""]));
}

export const CHECKS: Record<PrereqCheck, (ctx: PrereqContext) => Promise<CheckResult>> = {
  // The same reading the webhook settles by: an sk_live_ key and a webhook secret.
  "stripe.live-key": async ({ env }) =>
    stripeKeyMode(env) === "live" ? pass : fail("stripe.no-live-key"),
  "komoju.live-key": async ({ env }) =>
    komojuKeyMode(env) === "live" ? pass : fail("komoju.no-live-key"),
  // What lib/partner-ai.ts needs before it calls the model.
  "workers-ai.credentials": async ({ env }) =>
    set(env.CLOUDFLARE_ACCOUNT_ID) &&
    (set(env.CLOUDFLARE_AI_TOKEN) || set(env.CLOUDFLARE_API_TOKEN))
      ? pass
      : fail("workers-ai.no-credentials"),
  // Migration 0041: the per-reply charge table, and the ledger accepting reason 'ai'.
  "ai-credits.migration": async ({ d1 }) => {
    if (!d1) return fail("ai-credits.no-migration");
    try {
      const t = await tables(d1, ["credit_ai_charge", "credit_ledger"]);
      return t.has("credit_ai_charge") && /'ai'/.test(t.get("credit_ledger") ?? "")
        ? pass
        : fail("ai-credits.no-migration");
    } catch {
      return fail("ai-credits.no-migration");
    }
  },
  // lib/connections/google.ts googleConfig: the sign-in client, reused.
  "google.oauth-client": async ({ env }) =>
    set(env.AUTH_GOOGLE_ID) && set(env.AUTH_GOOGLE_SECRET) ? pass : fail("google.no-oauth-client"),
  "google.picker-key": async ({ env }) => (pickerConfig(env) ? pass : fail("google.no-picker-key")),
  // lib/connections/crypto.ts sealKey: refresh tokens are sealed with a key from it.
  "auth-secret": async ({ env }) =>
    (env.AUTH_SECRET?.length ?? 0) >= 32 ? pass : fail("auth.no-secret"),
};

export interface PrereqFailure {
  check: PrereqCheck;
  reason: PrereqReason;
  /** The reason's text on /dev/flags. */
  text: string;
}

/** The checks of `key` that fail now; empty = it may be turned on. */
export async function failedPrereqs(key: FlagKey, ctx: PrereqContext): Promise<PrereqFailure[]> {
  const requires = (FLAGS[key] as FlagDef).requires ?? [];
  const results = await Promise.all(requires.map((c) => CHECKS[c](ctx)));
  return results.flatMap((r, i) =>
    r.ok ? [] : [{ check: requires[i], reason: r.reason, text: PREREQ_REASONS[r.reason].zh }],
  );
}

/** `failedPrereqs` for every flag (for /dev/flags). */
export async function allFailedPrereqs(
  ctx: PrereqContext,
): Promise<Record<FlagKey, PrereqFailure[]>> {
  const keys = Object.keys(FLAGS) as FlagKey[];
  const all = await Promise.all(keys.map((k) => failedPrereqs(k, ctx)));
  return Object.fromEntries(keys.map((k, i) => [k, all[i]])) as Record<FlagKey, PrereqFailure[]>;
}

/**
 * What `POST /api/dev/flags` does once the caller is the owner and the request
 * is same-origin JSON: turning a flag ON with a failing prerequisite is
 * refused (400, with every reason); turning it OFF is never checked, so the
 * kill switch always works. Other refusals (unknown key, non-boolean) are the
 * store's FlagError, also 400.
 */
export async function changeFlag(
  d1: D1WithBatch,
  body: { key?: unknown; enabled?: unknown },
  by: string,
  ctx: PrereqContext,
): Promise<{ ok: true } | { ok: false; error: string; reasons?: PrereqFailure[] }> {
  if (body.enabled === true && isFlagKey(body.key)) {
    const reasons = await failedPrereqs(body.key, ctx);
    if (reasons.length) {
      console.log(
        JSON.stringify({
          event: "flags.set-refused",
          key: body.key,
          reasons: reasons.map((r) => r.reason),
          by,
        }),
      );
      return {
        ok: false,
        error: `${body.key} 还不能打开：${reasons.map((r) => r.text).join("；")}`,
        reasons,
      };
    }
  }
  try {
    await setFlag(d1, body.key, body.enabled, by);
  } catch (e) {
    if (e instanceof FlagError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}
