"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import type { ApplyResult, PreviewRow } from "@/lib/referrals/pregrant";

const newKey = () => crypto.randomUUID();

const tone: Record<PreviewRow["status"], string> = {
  ok: "text-[oklch(0.42_0.12_150)] dark:text-[oklch(0.8_0.13_150)]",
  invalid: "text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]",
  duplicate: "text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]",
  pending: "text-[oklch(0.45_0.01_250)] dark:text-[oklch(0.78_0.01_250)]",
  account: "text-[oklch(0.45_0.12_70)] dark:text-[oklch(0.82_0.12_80)]",
};

/**
 * Pre-grant panel (lib/referrals/pregrant.ts): paste addresses, preview, apply.
 * An address with an account is skipped unless "Grant now" is picked for it.
 * The server previews again on apply; this view only chooses.
 */
export default function PregrantPanel() {
  const c = useIntlayer("dev-pregrant");
  const router = useRouter();
  const [text, setText] = useState("");
  const [days, setDays] = useState(30);
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [direct, setDirect] = useState<Set<string>>(new Set());
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ApplyResult | null>(null);
  const [error, setError] = useState(false);

  // Any edit invalidates the preview: Apply only ever sends what was previewed.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setRows(null);
      setDone(null);
    };

  const body = (action: "preview" | "apply") => ({
    action,
    text,
    days,
    note: note || null,
    // The end of the chosen day, Japan time (the owner's clock).
    grantExpiresAt: expires ? `${expires}T23:59:59+09:00` : null,
    direct: [...direct],
    key,
  });

  async function send(action: "preview" | "apply") {
    setBusy(true);
    setError(false);
    try {
      const r = await fetch("/api/dev/pregrants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(action)),
      });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (action === "preview") {
        setRows(data.rows);
        setDirect(new Set());
      } else {
        setDone(data);
        setRows(null);
        setText("");
        setKey(newKey());
        router.refresh();
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const statusText = (r: PreviewRow) =>
    r.status === "account"
      ? c.statusAccount.value.replace("{email}", r.account?.email ?? "")
      : {
          ok: c.statusOk.value,
          invalid: c.statusInvalid.value,
          duplicate: c.statusDuplicate.value,
          pending: c.statusPending.value,
        }[r.status];

  const field = "w-full rounded border border-current/20 bg-transparent px-3 py-2";
  const button =
    "rounded border border-current/30 px-3 py-1.5 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[oklch(0.55_0.14_250)]";

  return (
    <section
      data-pregrant
      className="space-y-3 rounded border border-current/15 p-3 sm:p-4"
      aria-labelledby="pregrant-title"
    >
      <h2 id="pregrant-title" className="text-lg font-medium">
        {c.title}
      </h2>
      <p className="text-sm opacity-70">{c.intro}</p>
      <label className="block space-y-1 text-sm">
        <span>{c.listLabel}</span>
        <textarea
          data-pregrant-list
          value={text}
          onChange={(e) => edit(setText)(e.target.value)}
          rows={5}
          spellCheck={false}
          className={`${field} font-mono text-sm`}
          placeholder={"friend@example.com\nother@example.com,90,teacher"}
        />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block space-y-1 text-sm">
          <span>{c.days}</span>
          <input
            data-pregrant-days
            type="number"
            min={1}
            max={3660}
            value={days}
            onChange={(e) => edit(setDays)(Number(e.target.value))}
            className={field}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{c.expires}</span>
          <input
            data-pregrant-expires
            type="date"
            value={expires}
            onChange={(e) => edit(setExpires)(e.target.value)}
            className={field}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{c.note}</span>
          <input
            data-pregrant-note
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => edit(setNote)(e.target.value)}
            className={field}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          data-pregrant-preview
          className={button}
          disabled={busy || !text.trim()}
          onClick={() => send("preview")}
        >
          {c.preview}
        </button>
        <button
          data-pregrant-apply
          className={`${button} font-medium`}
          disabled={busy || !rows?.some((r) => r.status === "ok" || direct.has(r.email ?? ""))}
          onClick={() => send("apply")}
        >
          {c.apply}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="text-sm text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]"
        >
          {c.failed}
        </p>
      )}
      {done && (
        <p data-pregrant-done role="status" className="text-sm">
          {c.summary.value
            .replace("{created}", String(done.created))
            .replace("{granted}", String(done.granted))
            .replace("{skipped}", String(done.skipped))}
        </p>
      )}
      {rows && (
        <ul data-pregrant-rows className="divide-y divide-current/10 text-sm">
          {rows.map((r) => (
            <li
              key={r.line}
              data-status={r.status}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5"
            >
              <span className="min-w-0 break-all font-mono">{r.email ?? r.raw}</span>
              {r.days && <span className="tabular-nums opacity-70">+{r.days}</span>}
              <span className={tone[r.status]}>{statusText(r)}</span>
              {r.note && <span className="opacity-60 break-all">{r.note}</span>}
              {r.status === "account" && r.email && (
                <span className="inline-flex gap-1">
                  {(["grant", "skip"] as const).map((choice) => {
                    const on = direct.has(r.email!) === (choice === "grant");
                    return (
                      <button
                        key={choice}
                        data-choice={choice}
                        aria-pressed={on}
                        className={`rounded border px-2 py-0.5 text-xs ${on ? "border-current font-medium" : "border-current/20 opacity-70"}`}
                        onClick={() =>
                          setDirect((s) => {
                            const n = new Set(s);
                            if (choice === "grant") n.add(r.email!);
                            else n.delete(r.email!);
                            return n;
                          })
                        }
                      >
                        {choice === "grant" ? c.grantNow : c.skip}
                      </button>
                    );
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
