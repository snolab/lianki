"use client";

/**
 * /my/meetings (docs/meetings.md, "Pages"): the account's meetings, newest
 * first, in one VirtualList (continuous scroll, no pagination). Each row:
 * date in the device's zone, title, length, size, state; ⋯ Rename, Download,
 * Delete (one inline "Delete for good?"). Start sits at the top. Pieces left
 * in this browser by an earlier page are sent on arrival.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { VirtualList } from "@/app/components/VirtualList";
import { useInfiniteList } from "@/app/components/useInfiniteList";
import { clockOf, sizeOf } from "@/lib/meetings/core";
import { resumeLeftovers } from "@/lib/meetings/capture";
import type { MeetingView } from "@/lib/meetings/store";

type Batch = {
  meetings: MeetingView[];
  next: string | null;
  usedBytes: number;
  quotaBytes: number;
};

export default function MeetingsClient() {
  const t = useIntlayer("my-meetings");
  const { locale } = useLocale();
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; mode: "menu" | "rename" | "delete" } | null>(null);
  const [name, setName] = useState("");
  const [failed, setFailed] = useState(false);

  const fetchBatch = useCallback(async (cursor: string | null, size: number) => {
    const q = new URLSearchParams({ limit: String(size) });
    if (cursor) q.set("before", cursor);
    const r = await fetch(`/api/my/meetings?${q}`);
    if (!r.ok) throw new Error("list");
    const b = (await r.json()) as Batch;
    setUsage({ used: b.usedBytes, quota: b.quotaBytes });
    return { items: b.meetings, next: b.next };
  }, []);
  const list = useInfiniteList<MeetingView, string>({ fetchBatch, getKey: (m) => m.id, deps: [] });

  useEffect(() => {
    void resumeLeftovers().then((n) => n && list.reload());
    // Once, on arrival.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  const rename = async (id: string) => {
    const title = name.trim();
    if (!title) return;
    const r = await fetch(`/api/my/meetings/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (r.ok) list.setItems((xs) => xs.map((m) => (m.id === id ? { ...m, title } : m)));
    setMenu(null);
  };
  const remove = async (id: string) => {
    setFailed(false);
    const r = await fetch(`/api/my/meetings/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) list.setItems((xs) => xs.filter((m) => m.id !== id));
    else setFailed(true);
    setMenu(null);
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8" data-lk-private-screen="">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">{t.title}</h1>
        <Link href="/my/meetings/new" className="lk-btn lk-btn-primary" data-meeting-new="">
          ● {t.newMeeting}
        </Link>
      </div>
      <p className="mt-2 text-gray-600 dark:text-gray-400">{t.intro}</p>
      {usage && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t.used.value
            .replace("{used}", sizeOf(usage.used))
            .replace("{quota}", sizeOf(usage.quota))}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-3 text-sm">
          ⚠ {t.deleteFailed}
        </p>
      )}
      <VirtualList
        className="mt-6"
        items={list.items}
        getKey={(m) => m.id}
        name="meetings"
        hasMore={list.hasMore}
        loading={list.loading}
        error={list.error}
        onReachEnd={list.loadMore}
        estimateSize={84}
        gap={8}
        label={t.title.value}
        empty={<p className="text-gray-500">{t.empty}</p>}
        renderItem={(m) => (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
            <div className="flex items-start gap-3">
              <Link href={`/my/meetings/${m.id}`} className="min-w-0 flex-1">
                <div className="truncate font-semibold">{m.title ?? "—"}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-gray-600 dark:text-gray-400">
                  <span>{fmt.format(new Date(m.startedAt))}</span>
                  <span className="tabular-nums">{clockOf(m.durationMs)}</span>
                  <span className="tabular-nums">{sizeOf(m.bytes)}</span>
                  {m.status === "recording" && (
                    <span className="font-medium text-primary">● {t.statusRecording}</span>
                  )}
                  {m.status === "interrupted" && <span>⚠ {t.statusInterrupted}</span>}
                  {m.transcriptStatus === "waiting" && <span>{t.transcriptWaiting}</span>}
                  {m.transcriptStatus === "done" && <span>{t.transcriptDone}</span>}
                </div>
              </Link>
              <button
                type="button"
                className="px-2 text-xl leading-none"
                aria-label={t.more.value}
                title={t.more.value}
                aria-expanded={menu?.id === m.id}
                onClick={() => setMenu(menu?.id === m.id ? null : { id: m.id, mode: "menu" })}
              >
                ⋯
              </button>
            </div>
            {menu?.id === m.id && menu.mode === "menu" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="lk-btn lk-btn-secondary"
                  onClick={() => {
                    setName(m.title ?? "");
                    setMenu({ id: m.id, mode: "rename" });
                  }}
                >
                  {t.rename}
                </button>
                <a
                  className="lk-btn lk-btn-secondary"
                  href={`/api/my/meetings/${m.id}/download`}
                  download
                >
                  {t.download}
                </a>
                <button
                  type="button"
                  className="lk-btn lk-btn-secondary"
                  onClick={() => setMenu({ id: m.id, mode: "delete" })}
                >
                  {t.delete}
                </button>
              </div>
            )}
            {menu?.id === m.id && menu.mode === "rename" && (
              <form
                className="mt-3 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename(m.id);
                }}
              >
                <input
                  aria-label={t.renameLabel.value}
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-1.5"
                />
                <button type="submit" className="lk-btn lk-btn-primary">
                  {t.save}
                </button>
                <button type="button" className="lk-btn lk-btn-quiet" onClick={() => setMenu(null)}>
                  {t.cancel}
                </button>
              </form>
            )}
            {menu?.id === m.id && menu.mode === "delete" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span>{t.deleteConfirm}</span>
                <button
                  type="button"
                  className="lk-btn lk-btn-primary"
                  onClick={() => void remove(m.id)}
                >
                  {t.deleteYes}
                </button>
                <button type="button" className="lk-btn lk-btn-quiet" onClick={() => setMenu(null)}>
                  {t.cancel}
                </button>
              </div>
            )}
          </div>
        )}
      />
    </main>
  );
}
