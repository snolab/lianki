"use client";

/**
 * /list, signed in: every page card, soonest due first, as one virtual list
 * (app/components/VirtualList.tsx). No pages: more cards load from
 * /api/fsrs/list as the end comes near; only the rows near the screen are in
 * the DOM, so a deck of thousands scrolls as lightly as ten.
 */
import { useCallback } from "react";
import { cleanTitle, type TitleRule } from "@lianki/core/titleClean";
import { dueMs } from "@/app/ems";
import type { NoteRow } from "@/app/lib/notesAdmin";
import { VirtualList } from "@/app/components/VirtualList";
import { useInfiniteList } from "@/app/components/useInfiniteList";
import DeleteButton from "./DeleteButton";
import { ReviewHistory } from "./ReviewHistory";

export default function CardsList({ titleRules }: { titleRules: readonly TitleRule[] }) {
  const list = useInfiniteList<NoteRow, number>({
    getKey: (r) => r.url,
    deps: [],
    fetchBatch: async (page, size) => {
      const p = page ?? 0;
      const q = new URLSearchParams({
        sort: "due",
        order: "asc",
        page: String(p),
        size: String(size),
        logs: "1",
      });
      const res = await fetch(`/api/fsrs/list?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const { rows, total } = (await res.json()) as { rows: NoteRow[]; total: number };
      return { items: rows, next: (p + 1) * size < total ? p + 1 : null, total };
    },
  });
  const { setItems } = list;
  const drop = useCallback(
    (url: string) => setItems((rows) => rows.filter((r) => r.url !== url)),
    [setItems],
  );

  return (
    <VirtualList
      items={list.items}
      getKey={(r) => r.url}
      name="list"
      hasMore={list.hasMore}
      loading={list.loading}
      error={list.error}
      total={list.total}
      onReachEnd={list.loadMore}
      estimateSize={32}
      gap={8}
      testId="cards-list"
      rowClassName="break-words overflow-hidden"
      renderItem={(r) => (
        <div data-testid="list-card">
          {r.due ? dueMs(new Date(r.due)) : "?"} <ReviewHistory logs={r.log} />{" "}
          <a href={r.url} className="break-all">
            {(r.title && cleanTitle(r.title, { url: r.url, rules: titleRules })) || r.url}
          </a>
          <DeleteButton url={r.url} title={r.title} onDeleted={() => drop(r.url)} />
        </div>
      )}
    />
  );
}
