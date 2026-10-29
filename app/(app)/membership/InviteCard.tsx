"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import type { InviteSummary } from "@/lib/referrals/store";

/** The invite link and its results, plus the gift-code box. Renders nothing off D1. */
export function InviteCard({ onProChanged }: { onProChanged: () => void }) {
  const s = useIntlayer("invite-card");
  const [summary, setSummary] = useState<InviteSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [giftMsg, setGiftMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    fetch("/api/invite")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSummary)
      .catch(() => {});
  }, []);

  if (!summary) return null;
  const link = `${window.location.origin}/i/${summary.code}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  async function share() {
    try {
      await navigator.share({ text: `${s.shareText.value} ${link}` });
    } catch {}
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setRedeeming(true);
    setGiftMsg(null);
    try {
      const res = await fetch("/api/gift-codes/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as { status?: string; days?: number; reason?: string };
      if (data.status === "redeemed") {
        setGiftMsg({ ok: true, text: s.giftOk.value.replace("{days}", String(data.days)) });
        setCode("");
        onProChanged();
      } else {
        const used = data.reason === "already redeemed";
        setGiftMsg({ ok: false, text: used ? s.giftUsed.value : s.giftBad.value });
      }
    } catch {
      setGiftMsg({ ok: false, text: s.giftBad.value });
    } finally {
      setRedeeming(false);
    }
  }

  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 mt-8 space-y-6">
      <section className="space-y-3">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Icon name="gift" /> {s.title.value}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{s.description.value}</p>
        <div className="flex flex-wrap gap-2">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={copy}
            className="rounded-lg bg-blue-600 text-white px-4 py-2 font-semibold hover:bg-blue-700"
          >
            {copied ? s.copied.value : s.copy.value}
          </button>
          {canShare && (
            <button
              onClick={share}
              className="rounded-lg border border-blue-600 text-blue-600 dark:text-blue-300 px-4 py-2 font-semibold"
            >
              {s.share.value}
            </button>
          )}
        </div>
        <dl className="grid grid-cols-3 gap-3 text-center">
          {[
            [s.invited.value, summary.invited],
            [s.active.value, summary.activated],
            [s.earned.value, summary.earnedLastYear],
          ].map(([label, n]) => (
            <div key={String(label)} className="rounded-lg bg-gray-50 dark:bg-gray-900 p-3">
              <dd className="text-2xl font-bold text-gray-900 dark:text-white">{n}</dd>
              <dt className="text-xs text-gray-600 dark:text-gray-400">{label}</dt>
            </div>
          ))}
        </dl>
        {summary.friends.length > 0 && (
          <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
            {summary.friends.map((f) => (
              <li key={f.invitedAt + f.email} className="flex items-center gap-2">
                <Icon
                  name={f.activated ? "check" : "user"}
                  className={f.activated ? "text-green-600" : "opacity-50"}
                />
                <span className="font-mono">{f.email}</span>
                {f.purchased && <Icon name="star" className="text-yellow-500" />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        onSubmit={redeem}
        className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-6"
      >
        <h3 className="font-semibold text-gray-900 dark:text-white">{s.giftTitle.value}</h3>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={s.giftPlaceholder.value}
            autoCapitalize="characters"
            spellCheck={false}
            className="flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 font-mono"
          />
          <button
            type="submit"
            disabled={redeeming || !code.trim()}
            className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-4 py-2 font-semibold disabled:opacity-50"
          >
            {s.redeem.value}
          </button>
        </div>
        {giftMsg && (
          <p
            className={`text-sm ${giftMsg.ok ? "text-green-700 dark:text-green-300" : "text-red-600 dark:text-red-400"}`}
          >
            {giftMsg.text}
          </p>
        )}
      </form>
    </div>
  );
}
