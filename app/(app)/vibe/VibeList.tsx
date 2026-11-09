"use client";

/**
 * /vibe's list (docs/vibe.md, "Pages"): each conversation with its date, languages,
 * length and last update, and the same ⋯ menu as a /read row: Rename, and Delete,
 * which asks once. A material's delete cannot be undone, so there is no undo.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { longDate, longDateTime } from "@/lib/dates";
import type { VibeRow } from "@/lib/vibe/store";
import { RowMenu, TitleEditor } from "../reader/RowMenu";
import { langName } from "./lang-name";

const DIM = "text-[oklch(0.45_0_0)] dark:text-[oklch(0.72_0_0)]";

export function VibeList({ rows: initial, locale }: { rows: VibeRow[]; locale: string }) {
  const t = useIntlayer("vibe-page");
  const rowText = useIntlayer("read-row-menu");
  const [rows, setRows] = useState(initial);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Dates in the reader's own time zone: the server does not know it.
  const [browser, setBrowser] = useState(false);
  useEffect(() => setBrowser(true), []);

  const rename = async (r: VibeRow, title: string) => {
    const res = await fetch(`/api/read/${r.material}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { title?: string } | null;
    if (!res?.ok || !j?.title) return false;
    setRows((all) => all.map((x) => (x.id === r.id ? { ...x, title: j.title! } : x)));
    return true;
  };
  const remove = async (r: VibeRow) => {
    if (!confirm(rowText.confirmDelete.value.replace("{title}", r.title))) return;
    const res = await fetch(`/api/read/${r.material}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setRows((all) => all.filter((x) => x.id !== r.id));
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 pb-32 pt-6" data-testid="vibe-list">
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      <Link
        href="/vibe/new"
        data-testid="vibe-new"
        className="flex min-h-11 items-center justify-center rounded-lg bg-[oklch(0.5_0.176_22.3)] px-5 font-medium text-[oklch(0.99_0_0)]"
      >
        {t.again}
      </Link>
      {!rows.length && (
        <p className={DIM} data-testid="vibe-list-empty">
          {t.listEmpty}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li
            key={r.id}
            data-row-id={r.id}
            data-testid="vibe-row"
            className="flex items-center gap-2 rounded-lg border border-[oklch(0.7_0_0/0.5)] p-3 pe-1 dark:border-[oklch(0.45_0_0)]"
          >
            {renaming === r.id ? (
              <TitleEditor
                initial={r.title}
                onSave={(title) => rename(r, title)}
                onDone={() => setRenaming(null)}
              />
            ) : (
              <>
                <Link href={`/vibe/${r.id}`} className="min-w-0 flex-1" data-testid="vibe-row-link">
                  <h2 className="truncate font-medium" data-testid="vibe-row-title">
                    {r.title}
                  </h2>
                  <p className={`text-sm ${DIM}`} data-testid="vibe-row-meta">
                    {[
                      browser ? longDate(r.startedMs, locale) : "",
                      r.langs.map((l) => langName(l, locale)).join(", "),
                      t.rowLines.value.replaceAll("{n}", String(r.lines)),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {browser && (
                    <p className={`text-xs ${DIM}`} data-testid="vibe-row-updated">
                      {t.rowUpdated.value.replaceAll("{when}", longDateTime(r.lastMs, locale))}
                    </p>
                  )}
                </Link>
                <RowMenu
                  title={r.title}
                  onRename={() => setRenaming(r.id)}
                  onDelete={() => void remove(r)}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
