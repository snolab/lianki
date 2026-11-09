"use client";

import { useCallback, useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";

type Row = {
  id: number;
  at: number;
  action: "grant" | "revoke" | "regrant";
  permission: string;
  email: string;
  by: string;
  source: "cli" | "ui";
};
type Page = { rows?: Row[]; next?: number | null };

// ISO-like date and time in Tokyo, the owner's clock: "2026-11-09 17:42 JST".
const jst = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  dateStyle: "short",
  timeStyle: "short",
});
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

/**
 * Grants, re-grants and revokes from security_audit (GET
 * /api/dev/permissions/history), newest first, a page at a time. `version`
 * changes after each change on the page, which reloads the first page.
 */
export default function PermissionsHistory({ version }: { version: number }) {
  const c = useIntlayer("dev-permissions");
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before: number | null) => {
    setBusy(true);
    try {
      const q = before === null ? "" : `?before=${before}`;
      const r = await fetch(`/api/dev/permissions/history${q}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json().catch(() => ({}))) as Page;
      setRows((old) => [...(before === null ? [] : old), ...(j.rows ?? [])]);
      setNext(j.next ?? null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load, version]);

  const action = (a: Row["action"]) =>
    a === "grant" ? c.actGrant.value : a === "revoke" ? c.actRevoke.value : c.actRegrant.value;
  const perm = (p: string) => (p === "admin" ? c.admin.value : p === "dev" ? c.dev.value : p);

  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{c.historyHeading}</h2>
      {rows.length === 0 && !busy && <p className="text-sm opacity-70">{c.historyNone}</p>}
      <ul className="divide-y divide-[oklch(0.88_0_0)] dark:divide-[oklch(0.35_0_0)]">
        {rows.map((r) => (
          <li key={r.id} className="py-2 text-sm space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                {action(r.action)} · {perm(r.permission)}
              </span>
              <span className="opacity-70 tabular-nums">{jst.format(r.at)} JST</span>
            </div>
            <div className="font-mono break-all">{r.email}</div>
            <div className="opacity-70 break-all">
              {fill(c.historyBy.value, {
                who: r.by,
                source: r.source === "cli" ? c.sourceCli.value : c.sourceUi.value,
              })}
            </div>
          </li>
        ))}
      </ul>
      {next !== null && (
        <button
          type="button"
          onClick={() => void load(next)}
          disabled={busy}
          className="min-h-9 px-3 rounded border disabled:opacity-40"
        >
          {c.historyMore}
        </button>
      )}
    </section>
  );
}
