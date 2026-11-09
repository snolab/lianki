"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import type { GdocImport } from "@/lib/connections/gdoc-imports";
import { resyncGdoc } from "@/lib/connections/drive-pick";
import { relTime } from "@/lib/read/grade-handle";

/**
 * "Docs imported from Google" on /connections: each book with source_key
 * gdoc:<id>, when it was last synced, Open, and Sync again (the same import,
 * which updates the book in place; docs/connections.md, "Imported docs").
 */
export function GdocImportList(p: { imports: GdocImport[]; locale: string }) {
  const t = useIntlayer("drive-pick");
  const d = useIntlayer("read-gdoc-drive");
  const g = useIntlayer("read-gdoc");
  const c = useIntlayer("connections-page");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const errText = (code: string): string =>
    ({
      "not-granted": t.resyncNotGranted.value,
      reconnect: c.needsReconnect.value,
      "not-configured": d.notConfigured.value,
      "rate-limited": t.rateLimited.value,
      "too-large": g.errTooLarge.value,
      "too-much-text": g.errTooLarge.value,
      "no-text": g.errNoText.value,
      "not-found": g.errNotFound.value,
    })[code] ?? g.errFailed.value;

  async function resync(row: GdocImport) {
    setBusy(row.id);
    setErrors(({ [row.id]: _, ...rest }) => rest);
    const r = await resyncGdoc((u, i) => fetch(u, i), row.docId);
    setBusy(null);
    if (r.ok) router.refresh();
    else setErrors((e) => ({ ...e, [row.id]: errText(r.error) }));
  }

  return (
    <div className="pt-2 space-y-2" data-testid="gdoc-imports">
      <h3 className="text-sm font-semibold">{t.importedTitle}</h3>
      {p.imports.length === 0 ? (
        <p className="text-sm text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]">
          {t.importedEmpty}
        </p>
      ) : (
        <ul className="divide-y divide-[oklch(0.92_0.005_260)] dark:divide-[oklch(0.33_0.02_260)] rounded-lg border border-[oklch(0.92_0.005_260)] dark:border-[oklch(0.33_0.02_260)]">
          {p.imports.map((row) => (
            <li key={row.id} className="px-3 py-2.5" data-testid="gdoc-import-row">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/reader/${row.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {row.title}
                  </Link>
                  <p className="text-xs text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]">
                    <time dateTime={row.syncedAt} title={row.syncedAt} suppressHydrationWarning>
                      {t.synced.value.replace("{time}", relTime(row.syncedAt, p.locale))}
                    </time>
                  </p>
                </div>
                <Link
                  href={`/reader/${row.id}`}
                  className="shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium text-[oklch(0.5_0.187_22.3)] dark:text-[oklch(0.78_0.121_22.3)] hover:bg-[oklch(0.96_0.02_255)] dark:hover:bg-[oklch(0.3_0.044_22.3)]"
                >
                  {t.open}
                </Link>
                <button
                  type="button"
                  data-testid="gdoc-resync"
                  disabled={busy !== null}
                  onClick={() => void resync(row)}
                  className="shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)] hover:bg-[oklch(0.96_0.005_260)] dark:hover:bg-[oklch(0.3_0.02_260)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy === row.id ? t.resyncing : t.resync}
                </button>
              </div>
              {errors[row.id] && (
                <p
                  role="alert"
                  className="mt-1 text-xs text-[oklch(0.58_0.2_27)] dark:text-[oklch(0.72_0.16_27)]"
                >
                  {errors[row.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
