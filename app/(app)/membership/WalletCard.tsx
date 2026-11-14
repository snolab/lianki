"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { longDate } from "@/lib/dates";
import { PASSES, type PassId } from "@/lib/payments/passes";
import type { LedgerEntry } from "@/lib/payments/credits-store";
import { streakDayOf, streakNoteOf } from "@/lib/payments/login-streak";
import { isSignupBonus } from "@/lib/payments/signup-bonus";
import type { StreakView } from "@/lib/payments/login-streak-store";
import { useCredits, yen } from "./use-credits";

interface Provider {
  id: string;
  label: string;
  methods: string[];
}

interface Wallet {
  balance: number;
  entries: LedgerEntry[];
  /** The login streak (docs/payments.md, "Login-streak bonus"); absent while its flag is off. */
  streak?: StreakView;
  topup: { min: number; max: number; quick: number[]; providers: Provider[] };
}

type Notice = { ok: boolean; text: string } | null;

// Colours (oklch only, docs/design-principles.md).
// Seal red is the primary (buy / top up), a picked chip is stamped in gold;
// the neutrals are the warm paper→ink ramp (gray-*).
const card = "bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100";
const muted = "text-gray-600 dark:text-gray-400";
const accent = "bg-primary text-on-primary hover:bg-blue-700 disabled:opacity-50";
const chip =
  "rounded-full border px-4 py-2 font-semibold tabular-nums border-gray-300 dark:border-gray-600";
const chipOn = "bg-gold-100 dark:bg-gold-950 border-gold-600 dark:border-gold-300";
const well = "rounded-lg bg-gray-50 dark:bg-gray-900";

/**
 * The credit wallet on /membership: balance, top-up (quick amounts + custom,
 * only enabled providers), buying passes from the balance, and the ledger.
 * Renders nothing off D1 (the credits API answers 503 there).
 */
export function WalletCard({
  refreshKey,
  onProChanged,
}: {
  refreshKey: number;
  onProChanged: () => void;
}) {
  const s = useIntlayer("wallet-card");
  // The balance, pass prices paid from it and history are in credits; yen only
  // where money is charged (owner, 2026-11-03).
  const { credits, signed, topup: topupLabel } = useCredits();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [amount, setAmount] = useState<number>(600);
  const [custom, setCustom] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [missing, setMissing] = useState<number | null>(null);
  const [qr, setQr] = useState<{ qr: string; url?: string } | null>(null);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/payments/credits")
      .then((r) => (r.ok ? r.json() : null))
      .then((w: Wallet | null) => {
        setWallet(w);
        if (w?.topup.providers.length) setProviderId((p) => p ?? w.topup.providers[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Back from the provider's page: the webhook credits the wallet, not the redirect.
  const [backFromTopup, setBackFromTopup] = useState(false);
  useEffect(() => {
    setBackFromTopup(new URLSearchParams(window.location.search).has("topup"));
  }, []);

  if (!wallet) return null;
  const { min, max, quick, providers } = wallet.topup;
  const chosen = custom.trim() ? Number(custom) : amount;
  const valid = Number.isInteger(chosen) && chosen >= min && chosen <= max;

  function resetTurnstile() {
    turnstileRef.current?.reset();
    setTurnstileToken(null);
  }

  /** A failed top-up: one translated line, a fresh Turnstile token. */
  function topupFailed(text: string) {
    setNotice({ ok: false, text });
    resetTurnstile();
    setBusy(false);
  }

  async function topup(value: number) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/payments/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: value, provider: providerId, turnstileToken }),
      });
      const data = (await res.json()) as {
        kind?: "redirect" | "qr";
        url?: string;
        qr?: string;
        error?: string;
      };
      if (res.status === 429) return topupFailed(s.tooMany.value);
      if (res.status === 403 && data.error === "captcha") return topupFailed(s.captcha.value);
      if (res.ok && data.kind === "redirect" && data.url) return window.location.assign(data.url);
      if (res.ok && data.kind === "qr" && data.qr) {
        setQr({ qr: data.qr, url: data.url });
        setBusy(false);
        return;
      }
      throw new Error(`topup ${res.status} ${data.error ?? ""}`);
    } catch (e) {
      // The detail (status, the browser's network TypeError) is for the
      // console; the user reads the translated failure line.
      console.warn("[wallet] top-up failed:", e);
      topupFailed(s.failed.value);
    }
  }

  async function buy(passId: PassId) {
    setBusy(true);
    setNotice(null);
    setMissing(null);
    try {
      const res = await fetch("/api/payments/buy-pass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passId, key: crypto.randomUUID() }),
      });
      const data = (await res.json()) as {
        status?: string;
        proEndsAt?: string;
        missing?: number;
      };
      if (res.status === 402 && data.missing) {
        setMissing(data.missing);
        setCustom("");
        setAmount(data.missing);
        return;
      }
      if (!res.ok || !data.proEndsAt) throw new Error(`buy-pass ${res.status}`);
      setNotice({ ok: true, text: s.bought.value.replace("{date}", longDate(data.proEndsAt)) });
      load();
      onProChanged();
    } catch {
      setNotice({ ok: false, text: s.failed.value });
    } finally {
      setBusy(false);
    }
  }

  const canTopup = providers.length > 0 && !busy && (!siteKey || Boolean(turnstileToken));
  const reasonLabel = (r: LedgerEntry["reason"]) => s.reasons[r]?.value ?? r;
  // The retired account-age bonus (2026-11-14; docs/payments.md, "Login-streak
  // bonus") left `gift` rows whose refId names the tier; they keep their label.
  const ageLabel = (refId: string) => {
    const tier = /^agebonus:(d1|d7):/.exec(refId)?.[1];
    return tier === "d1" ? s.ageBonusDay1.value : tier === "d7" ? s.ageBonusDay7.value : null;
  };
  // A login-streak grant is a `gift` row too; its note holds the streak length.
  const streakLabel = (e: LedgerEntry) => {
    if (!streakDayOf(e.refId)) return null;
    const n = streakNoteOf(e.note);
    return s.streakDay.value.replace("{day}", String(n?.streak ?? ""));
  };
  const fill = (text: string, v: Record<string, string>) =>
    Object.entries(v).reduce((acc, [k, x]) => acc.replace(`{${k}}`, x), text);
  const streakLine = wallet.streak
    ? wallet.streak.today
      ? fill(s.streakToday.value, {
          day: String(wallet.streak.days),
          credits: credits(wallet.streak.credits),
        })
      : wallet.streak.credits > 0
        ? fill(s.streakAhead.value, {
            day: String(wallet.streak.days + 1),
            credits: credits(wallet.streak.credits),
          })
        : null
    : null;

  return (
    <section className={`${card} rounded-lg shadow-lg p-5 sm:p-8 mb-8 space-y-6`} data-wallet>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Icon name="star" /> {s.title.value}
          </h2>
          <p className={`text-sm mt-1 ${muted}`}>{s.description.value}</p>
        </div>
        <div className="text-right">
          <div className={`text-xs ${muted}`}>{s.balance.value}</div>
          <div className="text-3xl font-bold tabular-nums" data-wallet-balance>
            {credits(wallet.balance)}
          </div>
          {streakLine && (
            <div className={`text-xs mt-1 ${muted}`} data-wallet-streak>
              {streakLine}
            </div>
          )}
        </div>
      </header>

      {backFromTopup && !notice && (
        <p
          role="status"
          className="rounded-lg p-3 text-sm bg-[oklch(0.95_0.05_150)] text-[oklch(0.4_0.12_150)] dark:bg-[oklch(0.3_0.06_150)] dark:text-[oklch(0.88_0.08_150)]"
        >
          {s.toppedUp.value}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className={`rounded-lg p-3 text-sm ${
            notice.ok
              ? "bg-[oklch(0.95_0.05_150)] text-[oklch(0.4_0.12_150)] dark:bg-[oklch(0.3_0.06_150)] dark:text-[oklch(0.88_0.08_150)]"
              : "flex items-start gap-2 bg-[oklch(0.95_0.04_25)] text-[oklch(0.45_0.17_25)] dark:bg-[oklch(0.3_0.07_25)] dark:text-[oklch(0.88_0.08_25)]"
          }`}
        >
          {!notice.ok && <Icon name="warning" className="mt-0.5" />}
          {notice.text}
        </p>
      )}

      {/* Buy with balance */}
      <div className="space-y-2">
        <h3 className="font-semibold">{s.buyTitle.value}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {(["pro-1m", "pro-12m"] as const).map((id) => {
            const short = Math.max(0, PASSES[id].amount - wallet.balance);
            return (
              <li key={id} className={`${well} p-3 flex items-center justify-between gap-3`}>
                <div>
                  <div className="font-semibold">
                    {id === "pro-1m" ? s.oneMonth.value : s.twelveMonths.value}
                  </div>
                  <div className={`text-sm tabular-nums ${muted}`}>
                    {credits(PASSES[id].amount)}
                    {short > 0 && ` · ${s.short.value.replace("{missing}", credits(short))}`}
                  </div>
                </div>
                <button
                  onClick={() => void buy(id)}
                  disabled={busy}
                  className={`${accent} shrink-0 rounded-lg px-4 py-2 font-semibold`}
                  data-buy-with-balance={id}
                >
                  {s.buyWithBalance.value}
                </button>
              </li>
            );
          })}
        </ul>
        {missing !== null && (
          <div className={`${well} p-3 flex flex-wrap items-center justify-between gap-2`}>
            <span className="text-sm">{s.short.value.replace("{missing}", credits(missing))}</span>
            {providers.length > 0 ? (
              <button
                onClick={() => void topup(missing)}
                disabled={!canTopup}
                className={`${accent} rounded-lg px-4 py-2 font-semibold`}
              >
                {s.topupDifference.value.replace("{missing}", topupLabel(missing))}
              </button>
            ) : (
              <span className={`text-sm ${muted}`}>{s.noProviders.value}</span>
            )}
          </div>
        )}
      </div>

      {/* Top up */}
      <div className="space-y-3">
        <h3 className="font-semibold">{s.topupTitle.value}</h3>
        {providers.length === 0 ? (
          <>
            <p className={`text-sm ${muted}`}>{s.noProviders.value}</p>
            <ContactLine text={s.contact.value} />
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {quick.map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setAmount(q);
                    setCustom("");
                  }}
                  aria-pressed={!custom && amount === q}
                  className={`${chip} ${!custom && amount === q ? chipOn : ""}`}
                >
                  {yen(q)}
                  <span className={`block text-xs font-normal ${muted}`}>{credits(q)}</span>
                </button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className={`text-sm ${muted}`}>{s.customAmount.value}</span>
              <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={100}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={`${min}–${max}`}
                className="w-full rounded-lg border px-3 py-2 tabular-nums bg-transparent border-gray-300 dark:border-gray-600"
              />
            </label>
            {!valid && (
              <p className="flex items-center gap-1.5 text-sm text-[oklch(0.5_0.18_25)] dark:text-[oklch(0.78_0.12_25)]">
                <Icon name="warning" />
                {s.range.value.replace("{min}", yen(min)).replace("{max}", yen(max))}
              </p>
            )}
            {providers.length > 1 && (
              <fieldset className="space-y-1">
                <legend className={`text-sm ${muted}`}>{s.payWith.value}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {providers.map((p) => (
                    <label
                      key={p.id}
                      className={`${chip} rounded-lg flex items-start gap-2 cursor-pointer ${providerId === p.id ? chipOn : ""}`}
                    >
                      <input
                        type="radio"
                        name="provider"
                        checked={providerId === p.id}
                        onChange={() => setProviderId(p.id)}
                        className="mt-1"
                      />
                      <span>
                        {p.label}
                        <span className={`block text-xs font-normal ${muted}`}>
                          {p.methods.join(" · ")}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {providers.length === 1 && (
              <p className={`text-xs ${muted}`}>{providers[0].methods.join(" · ")}</p>
            )}
            {siteKey && (
              <Turnstile
                ref={turnstileRef}
                siteKey={siteKey}
                onSuccess={setTurnstileToken}
                onExpire={resetTurnstile}
                onError={() => setTurnstileToken(null)}
                options={{ theme: "auto", size: "flexible", appearance: "interaction-only" }}
              />
            )}
            <button
              onClick={() => void topup(chosen)}
              disabled={!canTopup || !valid}
              className={`${accent} w-full rounded-lg px-6 py-3 font-semibold`}
              data-topup
            >
              {s.topupButton.value.replace("{amount}", valid ? topupLabel(chosen) : "")}
            </button>
            {qr && (
              <div className={`${well} p-4 flex flex-col items-center gap-2`}>
                {/^(data:image\/|https:)/.test(qr.qr) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr.qr} alt="" className="w-48 h-48" />
                ) : (
                  <code className="break-all text-xs">{qr.qr}</code>
                )}
                {qr.url && (
                  <a href={qr.url} className="underline text-sm">
                    {qr.url}
                  </a>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* History */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">{s.history.value}</h3>
          <Link
            href="/membership/credits"
            data-credits-usage-link=""
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium underline underline-offset-2 text-blue-600 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
          >
            <Icon name="list" /> {s.usageLink.value}
          </Link>
        </div>
        {wallet.entries.length === 0 ? (
          <p className={`text-sm ${muted}`}>{s.empty.value}</p>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            {wallet.entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div>
                    {streakLabel(e) ??
                      ageLabel(e.refId) ??
                      (isSignupBonus(e.refId) ? s.signupBonus.value : null) ??
                      reasonLabel(e.reason)}
                    {e.passId === "pro-1m" && ` · ${s.oneMonth.value}`}
                    {e.passId === "pro-12m" && ` · ${s.twelveMonths.value}`}
                  </div>
                  <div className={`text-xs ${muted}`}>{longDate(e.createdAt)}</div>
                </div>
                <span
                  className={`font-semibold tabular-nums ${
                    e.amount > 0 ? "text-[oklch(0.5_0.14_150)] dark:text-[oklch(0.8_0.12_150)]" : ""
                  }`}
                >
                  {signed(e.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The "[…]" part of the sentence becomes a link to the contact form. */
function ContactLine({ text }: { text: string }) {
  const m = /^(.*?)\[(.+?)\](.*)$/s.exec(text);
  const [before, label, after] = m ? [m[1], m[2], m[3]] : [text, null, ""];
  return (
    <p className={`text-sm ${muted}`}>
      {before}
      {label && (
        <Link
          href="/contacts"
          className="font-medium underline underline-offset-2 text-blue-600 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200"
        >
          {label}
        </Link>
      )}
      {after}
    </p>
  );
}
