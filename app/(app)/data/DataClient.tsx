"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { fill } from "@/lib/roadmap/labels";
import {
  deleteLocalCards,
  readLocalStore,
  readUserscriptStatus,
  wipeLocalStore,
  type LocalCard,
  type LocalSnapshot,
  type UserscriptStatus,
} from "@/app/lib/localStore";
import { queuePurge } from "@/lib/local-purge";
import type { HostGroup, NoteRow, StoreStats } from "@/app/lib/notesAdmin";
import BackupSection from "./BackupSection";
import { useInfiniteList } from "@/app/components/useInfiniteList";
import CardTable from "./CardTable";
import DangerZone from "./DangerZone";
import HostPanel from "./HostPanel";
import StoreConsole from "./StoreConsole";
import { type DataRow, type StoreId } from "./types";
import { dataFiltersToQuery, defaultFilters, parseDataFilters } from "@/lib/data-filters";

/** `/api/fsrs/bulk-upsert` caps a request at 500 notes. */
const PUSH_BATCH = 200;

function localToRow(card: LocalCard): NoteRow {
  return {
    url: card.url,
    title: card.title || card.url,
    state: card.card.state ?? 0,
    due: card.card.due ? new Date(card.card.due).toISOString() : "",
    reps: card.card.reps ?? 0,
    lapses: card.card.lapses ?? 0,
    hlc: card.hlc,
  };
}

export default function DataClient({
  isLoggedIn: serverSignedIn,
  dev = false,
}: {
  isLoggedIn: boolean;
  /** Holds `dev` (lib/permissions.ts): the stores' and sites' diagnostics are shown. */
  dev?: boolean;
}) {
  // On a box, from lianki.com (BoxApiBridge); else the server's answer.
  const isLoggedIn = useSignedIn(serverSignedIn);
  const t = useIntlayer("data-page");

  // ── Stores ────────────────────────────────────────────────────────────────
  const [script, setScript] = useState<UserscriptStatus | null>(null);
  const [local, setLocal] = useState<LocalSnapshot | null>(null);
  const [cloud, setCloud] = useState<StoreStats | null>(null);
  /** Every cloud url, for the "in stores" column and the push diff. */
  const [cloudUrls, setCloudUrls] = useState<Set<string> | null>(null);

  // ── Table ─────────────────────────────────────────────────────────────────
  // Filters live in the URL so a view can be bookmarked, shared, or reopened as
  // you left it. Read once on mount; from then on state drives the URL, not the
  // reverse — a two-way binding here loops, since every write re-renders.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const defaults = useMemo(() => defaultFilters(isLoggedIn), [isLoggedIn]);
  const [initial] = useState(() => parseDataFilters(searchParams, defaults));

  const [store, setStore] = useState<StoreId>(initial.store);
  const [q, setQ] = useState(initial.q);
  const [state, setState] = useState<number | null>(initial.state);
  const [onlyDue, setOnlyDue] = useState(initial.onlyDue);
  const [sort, setSort] = useState(initial.sort);
  const [order, setOrder] = useState<"asc" | "desc">(initial.order);
  const [error, setError] = useState<string | null>(null);
  // The search box waits for typing to pause before the cloud list restarts.
  const [dq, setDq] = useState(initial.q);
  useEffect(() => {
    const id = setTimeout(() => setDq(q), 200);
    return () => clearTimeout(id);
  }, [q]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // ── Hosts ─────────────────────────────────────────────────────────────────
  const [hosts, setHosts] = useState<HostGroup[]>([]);
  const [hostsLoading, setHostsLoading] = useState(true);

  // ── Push ──────────────────────────────────────────────────────────────────
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => {
    try {
      setLocal(await readLocalStore());
    } catch (err) {
      console.error("[Lianki] failed to read the local store:", err);
      setLocal({ cards: [], gmCount: null });
    }
  }, []);

  const refreshCloud = useCallback(async () => {
    if (!isLoggedIn) return;
    try {
      const [statsRes, listRes] = await Promise.all([
        fetch("/api/fsrs/stats"),
        // One unfiltered page big enough to diff Local against Cloud. The table
        // itself pages server-side; this is only the "which store holds it" set.
        fetch(`/api/fsrs/list?size=200&page=0`),
      ]);
      if (statsRes.ok) setCloud(await statsRes.json());
      if (listRes.ok) {
        const data: { rows: NoteRow[] } = await listRes.json();
        setCloudUrls(new Set(data.rows.map((r) => r.url)));
      }
    } catch (err) {
      console.error("[Lianki] failed to read cloud stats:", err);
    }
  }, [isLoggedIn]);

  const refreshHosts = useCallback(async () => {
    if (!isLoggedIn) {
      setHostsLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/fsrs/hosts");
      if (res.ok) setHosts(((await res.json()) as { hosts: HostGroup[] }).hosts);
    } catch (err) {
      console.error("[Lianki] failed to group cards by host:", err);
    } finally {
      setHostsLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    setScript(readUserscriptStatus());
    void refreshLocal();
    void refreshCloud();
    void refreshHosts();
  }, [refreshLocal, refreshCloud, refreshHosts]);

  // Cloud table: server-side filter and sort; no pages (owner, 2026-11-10) —
  // more rows as the table nears its end, a filter or sort starts over.
  const cloudList = useInfiniteList<NoteRow, number>({
    getKey: (r) => r.url,
    deps: [dq, state, onlyDue, sort, order],
    enabled: store === "cloud" && isLoggedIn,
    fetchBatch: async (page, size) => {
      const at = page ?? 0;
      const params = new URLSearchParams({
        page: String(at),
        size: String(size),
        sort,
        order,
        due: onlyDue ? "due" : "all",
      });
      if (dq) params.set("q", dq);
      if (state != null) params.set("state", String(state));
      const res = await fetch(`/api/fsrs/list?${params}`);
      if (!res.ok) throw new Error(`Failed to load cards (${res.status})`);
      const data: { rows: NoteRow[]; total: number } = await res.json();
      return {
        items: data.rows,
        next: (at + 1) * size < data.total ? at + 1 : null,
        total: data.total,
      };
    },
  });
  const cloudRows = cloudList.items;
  const setCloudRows = cloudList.setItems;
  /** Rows deleted here since the last batch counted the total. */
  const [cloudGone, setCloudGone] = useState(0);
  const cloudTotal = Math.max(0, (cloudList.total ?? 0) - cloudGone);
  useEffect(() => setCloudGone(0), [cloudList.total]);

  const localUrls = useMemo(() => new Set((local?.cards ?? []).map((c) => c.url)), [local]);

  // Local table: the same filter/sort/page, applied in memory.
  const localFiltered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const now = Date.now();
    const rows = (local?.cards ?? [])
      .filter((c) => {
        if (needle && !`${c.title ?? ""} ${c.url}`.toLowerCase().includes(needle)) return false;
        if (state != null && (c.card.state ?? 0) !== state) return false;
        if (onlyDue && new Date(c.card.due).getTime() > now) return false;
        return true;
      })
      .map(localToRow);

    const dir = order === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sort) {
        case "title":
          return dir * a.title.localeCompare(b.title);
        case "url":
          return dir * a.url.localeCompare(b.url);
        case "reps":
          return dir * (a.reps - b.reps);
        case "lapses":
          return dir * (a.lapses - b.lapses);
        case "state":
          return dir * (a.state - b.state);
        default:
          return dir * (new Date(a.due).getTime() - new Date(b.due).getTime());
      }
    });
    return rows;
  }, [local, q, state, onlyDue, sort, order]);

  const activeRows: DataRow[] = useMemo(() => {
    const source = store === "cloud" ? cloudRows : localFiltered;
    const syncedByUrl = new Map((local?.cards ?? []).map((c) => [c.url, c.synced]));
    return source.map((row) => ({
      ...row,
      inLocal: localUrls.has(row.url),
      // With no cloud listing yet, don't claim a card is missing from the cloud.
      inCloud: store === "cloud" ? true : (cloudUrls?.has(row.url) ?? false),
      synced: syncedByUrl.get(row.url),
    }));
  }, [store, cloudRows, localFiltered, localUrls, cloudUrls, local]);

  const total = store === "cloud" ? cloudTotal : localFiltered.length;

  // Push candidates: mirrored locally, absent from the cloud listing.
  const pushCandidates = useMemo(() => {
    if (!isLoggedIn || !cloudUrls) return [];
    return (local?.cards ?? []).filter((c) => !cloudUrls.has(c.url));
  }, [isLoggedIn, cloudUrls, local]);

  // Mirror the filters into the query string. `replace`, not `push`: typing a
  // search term would otherwise leave one history entry per keystroke, and Back
  // would walk the user through their own typing instead of leaving the page.
  const lastQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const write = () => {
      const query = dataFiltersToQuery(
        { store, q, state, onlyDue, sort, order, page: 0 },
        defaults,
        searchParams,
      );
      if (query === lastQueryRef.current) return;
      lastQueryRef.current = query;
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    };

    // Only the text box needs debouncing; a dropdown or checkbox is one event.
    const timer = setTimeout(write, 300);
    return () => clearTimeout(timer);
  }, [store, q, state, onlyDue, sort, order, defaults, pathname, router, searchParams]);

  function changeSort(next: string) {
    if (next === sort) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(next);
      setOrder("asc");
    }
  }

  function changeStore(next: StoreId) {
    setStore(next);
    setSelected(new Set());
  }

  async function pushLocalToCloud() {
    setPushing(true);
    setPushResult(null);
    try {
      let upserted = 0;
      let conflicts = 0;
      for (let i = 0; i < pushCandidates.length; i += PUSH_BATCH) {
        const batch = pushCandidates.slice(i, i + PUSH_BATCH);
        const res = await fetch("/api/fsrs/bulk-upsert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            notes: batch.map((c) => ({
              url: c.url,
              title: c.title,
              card: c.card,
              log: c.log ?? [],
              hlc: c.hlc,
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`bulk-upsert ${res.status} ${data.error ?? ""}`);
        upserted += data.upserted ?? 0;
        conflicts += data.conflicts ?? 0;
      }
      const pushed = fill(t.store.pushed.value, { n: upserted });
      setPushResult(
        conflicts ? `${pushed} · ${fill(t.store.skipped.value, { n: conflicts })}` : pushed,
      );
      await refreshCloud();
    } catch (err) {
      console.warn("[data] copy to account failed:", err);
      setPushResult(t.errors.pushFailed.value);
    } finally {
      setPushing(false);
    }
  }

  async function deleteSelected() {
    const urls = [...selected];
    if (!urls.length) return;
    const where = store === "local" ? t.errors.storeLocal.value : t.errors.storeCloud.value;
    if (!confirm(fill(t.errors.confirmDelete.value, { n: urls.length, store: where }))) return;

    setDeleting(true);
    try {
      if (store === "local") {
        await deleteLocalCards(urls);
        await refreshLocal();
      } else {
        const res = await fetch("/api/fsrs/bulk-delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ urls }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(`bulk-delete ${res.status} ${data.error ?? ""}`);
        }
        setCloudRows((rows) => rows.filter((r) => !selected.has(r.url)));
        setCloudGone((g) => g + urls.length);
        await refreshCloud();
      }
      // Both branches: the userscript's GM storage is a third copy, and it is
      // the one that decides which card you are shown next. Without this, a
      // deleted card keeps being served and re-appears in the local mirror on
      // the next sync.
      queuePurge(urls);
      setSelected(new Set());
    } catch (err) {
      console.warn("[data] delete failed:", err);
      setError(t.host.deleteFailed.value);
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Delete every card on one host, from all three stores.
   *
   * The urls are fetched rather than derived from the table, which only ever
   * holds the current page — the case this exists for is a host with dozens of
   * cards spread across it. `q` matches url and title, so each candidate's host
   * is re-checked here: a card merely *mentioning* the host in its title must
   * not be swept up in a delete-all.
   */
  async function deleteHost(host: string) {
    const params = new URLSearchParams({ q: host, size: "1000", page: "0", due: "all" });
    const res = await fetch(`/api/fsrs/list?${params}`);
    if (!res.ok) throw new Error(`Could not list cards on ${host} (${res.status})`);
    const { rows } = (await res.json()) as { rows: NoteRow[] };
    const urls = rows
      .filter((r) => {
        try {
          return new URL(r.url).host === host;
        } catch {
          return host === "(unparseable)";
        }
      })
      .map((r) => r.url);
    if (!urls.length) return;

    // The endpoint caps a request at 1000 urls.
    for (let i = 0; i < urls.length; i += 1000) {
      const batch = urls.slice(i, i + 1000);
      const del = await fetch("/api/fsrs/bulk-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: batch }),
      });
      if (!del.ok) {
        const data = await del.json().catch(() => ({}));
        throw new Error(`bulk-delete ${del.status} ${data.error ?? ""}`);
      }
    }
    // The browser mirror and the userscript's GM storage are the other two
    // copies; the second is the one that decides which card you see next.
    await deleteLocalCards(urls);
    queuePurge(urls);

    setCloudRows((prev) => prev.filter((r) => !urls.includes(r.url)));
    setSelected(new Set());
    await Promise.all([refreshCloud(), refreshLocal(), refreshHosts()]);
  }

  async function rename(url: string, title: string) {
    if (store !== "cloud") return;
    const res = await fetch(`/api/fsrs/notes?url=${encodeURIComponent(url)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      console.warn("[data] rename failed:", res.status);
      setError(t.errors.renameFailed.value);
      return;
    }
    setCloudRows((rows) => rows.map((r) => (r.url === url ? { ...r, title } : r)));
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-bold mb-1">{t.title}</h1>
        <p className="text-gray-600 dark:text-gray-400">{t.subtitle}</p>
      </header>

      <StoreConsole
        heading={t.storesHeading.value}
        script={script}
        local={local}
        cloud={cloud}
        isLoggedIn={isLoggedIn}
        pendingPush={pushCandidates.length}
        pushing={pushing}
        pushResult={pushResult}
        pushLabel={t.pushLabel.value}
        onPush={pushLocalToCloud}
        scriptHint={t.scriptHint.value}
        dev={dev}
      />

      <CardTable
        heading={t.cardsHeading.value}
        store={store}
        onStoreChange={changeStore}
        cloudAvailable={isLoggedIn}
        rows={activeRows}
        total={total}
        loading={store === "cloud" ? cloudList.loading : local === null}
        error={error ?? (store === "cloud" && cloudList.error ? t.errors.loadFailed.value : null)}
        hasMore={store === "cloud" && cloudList.hasMore}
        listError={store === "cloud" && cloudList.error}
        onReachEnd={cloudList.loadMore}
        q={q}
        onQChange={setQ}
        state={state}
        onStateChange={setState}
        onlyDue={onlyDue}
        onOnlyDueChange={setOnlyDue}
        sort={sort}
        order={order}
        onSortChange={changeSort}
        selected={selected}
        onSelectedChange={setSelected}
        onDeleteSelected={deleteSelected}
        deleting={deleting}
        editable={store === "cloud"}
        onRename={rename}
        deleteSelectedLabel={t.deleteSelected.value}
      />

      {isLoggedIn && (
        <HostPanel hosts={hosts} loading={hostsLoading} onDeleteHost={deleteHost} dev={dev} />
      )}

      <BackupSection
        heading={t.backupHeading.value}
        exportLabel={t.exportLabel.value}
        isLoggedIn={isLoggedIn}
        localCards={local?.cards ?? []}
      />

      <DangerZone
        heading={t.dangerHeading.value}
        wipeLocalLabel={t.wipeLocal.value}
        deleteAllLabel={t.deleteAllCloud.value}
        confirmHint={t.confirmHint.value}
        isLoggedIn={isLoggedIn}
        localCount={local?.cards.length ?? 0}
        cloudCount={cloud?.notes ?? null}
        onWipeLocal={async () => {
          const n = await wipeLocalStore();
          // The mirror is rebuilt from the userscript's GM storage on its next
          // sync, so wiping only IndexedDB puts every card straight back.
          queuePurge([], { all: true });
          await refreshLocal();
          setSelected(new Set());
          return fill(t.danger.wiped.value, { n });
        }}
        onDeleteAllCloud={async () => {
          const res = await fetch("/api/fsrs/bulk-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ all: true, confirm: "DELETE" }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`bulk-delete ${res.status} ${data.error ?? ""}`);
          setCloudRows([]);
          setCloudGone(cloudList.total ?? 0);
          setSelected(new Set());
          queuePurge([], { all: true });
          await refreshCloud();
          return fill(t.danger.deleted.value, { n: data.deleted });
        }}
      />
    </div>
  );
}
