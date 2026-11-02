"use client";

import { useState } from "react";
import { longDateTime } from "@/lib/dates";
import type { LedgerEntry } from "@/lib/payments/credits-store";

type View = {
  email: string;
  proEndsAt: string | null;
  balance: number;
  entries: LedgerEntry[];
};

const field =
  "rounded-lg border border-[oklch(0_0_0/0.15)] dark:border-[oklch(1_0_0/0.15)] bg-transparent px-3 py-2";

/** Look an account up, see its wallet, add or take credits, refund entries. */
export default function CreditsAdmin({ defaultEmail }: { defaultEmail: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [amount, setAmount] = useState(600);
  const [reason, setReason] = useState<"sponsor" | "adjust" | "gift">("adjust");
  const [note, setNote] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(target = email) {
    const r = await fetch(`/api/dev/credits?email=${encodeURIComponent(target)}`);
    const data = await r.json();
    if (!r.ok) {
      setView(null);
      setMsg(data.error ?? `HTTP ${r.status}`);
    } else setView(data);
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/dev/credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      setMsg(r.ok ? `OK: ${data.status ?? "applied"}` : (data.error ?? data.status ?? r.status));
      if (view) await load(view.email);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`${field} flex-1 min-w-0`}
        />
        <button onClick={() => void load()} disabled={!email} className={field}>
          查询
        </button>
      </div>

      {view && (
        <section className="space-y-3 rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 text-sm">
          <div>
            <b>{view.email}</b> · 余额 <b data-balance>¥{view.balance.toLocaleString()}</b> · Pro
            到期 {view.proEndsAt ? longDateTime(view.proEndsAt) : "—"}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              value={amount}
              step={100}
              onChange={(e) => setAmount(Number(e.target.value))}
              className={`${field} w-28`}
            />
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as typeof reason)}
              className={field}
            >
              <option value="adjust">adjust</option>
              <option value="sponsor">sponsor</option>
              <option value="gift">gift</option>
            </select>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="备注"
              className={`${field} flex-1 min-w-0`}
            />
            <button
              disabled={busy || !amount}
              onClick={() =>
                void post({ action: "credit", email: view.email, amount, reason, note })
              }
              className="rounded-lg bg-[var(--brand)] px-4 py-2 text-[oklch(1_0_0)]"
            >
              {amount < 0 ? "扣除" : "加入"}
            </button>
          </div>
          <ul className="divide-y divide-[oklch(0_0_0/0.08)] dark:divide-[oklch(1_0_0/0.08)]">
            {view.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="w-20 text-right font-mono tabular-nums">
                  {e.amount > 0 ? "+" : ""}
                  {e.amount}
                </span>
                <span className="opacity-70">{e.reason}</span>
                {e.passId && <span className="opacity-70">{e.passId}</span>}
                <span className="text-xs opacity-50">{longDateTime(e.createdAt)}</span>
                {e.note && <span className="text-xs opacity-60">{e.note}</span>}
                {(e.reason === "pass" || e.reason === "topup") && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void post({
                        action: e.reason === "pass" ? "refund-pass" : "reverse-topup",
                        refId: e.refId,
                        note: note || undefined,
                      })
                    }
                    className="ml-auto text-xs underline"
                  >
                    {e.reason === "pass" ? "退回余额" : "撤回充值"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
