"use client";

import { useCallback, useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { InviteEmailStatus } from "@/lib/referrals/email-invite";

type Msg = { ok: boolean; text: string } | null;

/**
 * "Invite by email" inside the invite card (lib/referrals/email-invite.ts).
 * Renders nothing unless the server says this user may send: Pro users with the
 * flag on, admins always. One address per send; the result is neutral.
 */
export function EmailInviteBox() {
  const s = useIntlayer("email-invite");
  const [status, setStatus] = useState<InviteEmailStatus | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    fetch("/api/invite/email")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: InviteEmailStatus | null) => setStatus(v))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  if (!status?.allowed) return null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/invite/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setMsg({ ok: true, text: s.sent.value });
        setEmail("");
      } else if (res.status === 400) setMsg({ ok: false, text: s.invalid.value });
      else if (res.status === 429) setMsg({ ok: false, text: s.limit.value });
      else setMsg({ ok: false, text: s.failed.value });
    } catch {
      setMsg({ ok: false, text: s.failed.value });
    } finally {
      setBusy(false);
      load();
    }
  }

  const fmt = (t: string, v: Record<string, number>) =>
    t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
  const date = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <form
      onSubmit={send}
      data-qa="email-invite"
      className="space-y-2 border-t border-[oklch(0.5_0.02_250/0.25)] pt-6"
    >
      <h3 className="font-semibold text-[var(--foreground)]">{s.title.value}</h3>
      <p className="text-sm text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]">
        {fmt(s.hint.value, { days: status.recipientDays })}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={s.label.value}
          aria-label={s.label.value}
          data-qa="email-invite-input"
          className="min-h-11 min-w-0 flex-1 basis-48 rounded-lg border border-[oklch(0.5_0.02_250/0.35)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)]"
        />
        <button
          type="submit"
          disabled={busy || !email.trim() || status.remaining <= 0}
          data-qa="email-invite-send"
          className="min-h-11 rounded-lg bg-[oklch(0.45_0.18_260)] px-4 py-2 font-semibold text-[oklch(1_0_0)] hover:bg-[oklch(0.4_0.18_260)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.55_0.14_250)] disabled:opacity-50"
        >
          {busy ? s.sending.value : s.send.value}
        </button>
      </div>
      <p
        className="text-xs text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]"
        data-qa="email-invite-remaining"
      >
        {fmt(s.remaining.value, { n: status.remaining, limit: status.limit })}
      </p>
      {msg && (
        <p
          role="status"
          data-qa="email-invite-msg"
          className={`text-sm ${msg.ok ? "text-[oklch(0.42_0.12_150)] dark:text-[oklch(0.8_0.12_150)]" : "text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]"}`}
        >
          {msg.text}
        </p>
      )}
      {status.history.length > 0 && (
        <div className="pt-2">
          <h4 className="text-xs font-semibold text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]">
            {s.history.value}
          </h4>
          <ul className="text-sm text-[var(--foreground)]" data-qa="email-invite-history">
            {status.history.map((h) => (
              <li key={`${h.at}-${h.to}`} className="flex flex-wrap justify-between gap-x-2">
                <span className="font-mono break-all">{h.to}</span>
                <span className="text-xs text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]">
                  {date(h.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
