"use client";

import { useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { AgeBonusApplied, AgeBonusPlan } from "@/lib/payments/age-bonus-store";

const button =
  "rounded-lg border border-[oklch(0_0_0/0.15)] dark:border-[oklch(1_0_0/0.15)] bg-transparent px-3 py-2 disabled:opacity-50";

const fill = (s: string, v: Record<string, number>) =>
  Object.entries(v).reduce((acc, [k, n]) => acc.replace(`{${k}}`, n.toLocaleString()), s);

/**
 * The account-age bonus backfill (docs/payments.md, "Account-age bonus"):
 * Preview counts what is owed now; Apply grants it (idempotent). Apply asks
 * first, with the numbers of the last preview.
 */
export default function AgeBonusPanel() {
  const c = useIntlayer("dev-age-bonus");
  const [plan, setPlan] = useState<AgeBonusPlan | null>(null);
  const [done, setDone] = useState<AgeBonusApplied | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function call<T>(action: "preview" | "apply"): Promise<T | null> {
    setBusy(true);
    setError(false);
    try {
      const r = await fetch("/api/dev/credits/age-bonus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as T;
    } catch {
      setError(true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    setDone(null);
    setPlan(await call<AgeBonusPlan>("preview"));
  }

  async function apply() {
    if (!plan) return;
    if (!confirm(fill(c.confirm.value, { credits: plan.credits, users: plan.users }))) return;
    const r = await call<AgeBonusApplied>("apply");
    if (r) {
      setDone(r);
      setPlan(null);
    }
  }

  return (
    <section
      data-age-bonus=""
      className="space-y-3 rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 text-sm"
    >
      <h2 className="text-lg font-semibold">{c.title.value}</h2>
      <p className="opacity-70">{c.intro.value}</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void preview()} disabled={busy} className={button}>
          {c.preview.value}
        </button>
        <button
          onClick={() => void apply()}
          disabled={busy || !plan || plan.users === 0}
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-[oklch(1_0_0)] disabled:opacity-50"
        >
          {c.apply.value}
        </button>
      </div>
      {plan && (
        <p data-age-bonus-plan="">
          {fill(c.owed.value, {
            d1: plan.usersD1,
            d7: plan.usersD7,
            users: plan.users,
            credits: plan.credits,
          })}
        </p>
      )}
      {done && (
        <p data-age-bonus-done="">
          {fill(c.applied.value, {
            d1: done.usersD1,
            d7: done.usersD7,
            users: done.users,
            credits: done.credits,
            failed: done.failed,
          })}
        </p>
      )}
      {error && <p role="alert">{c.failed.value}</p>}
    </section>
  );
}
