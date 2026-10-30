"use client";

/**
 * The command palette (docs/bottom-nav.md): one search over pages and
 * commands, word lists and words (the offline copy), cards (the server) and,
 * in debug mode, the state tree. A pasted URL offers to add it as a card.
 * Modal: role="dialog", Escape or the backdrop closes it.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/app/components/icons";
import { APP_NAV } from "@/lib/app-nav";
import { idbAll, idbGet } from "@/lib/words/idb";
import { parseTree } from "@lianki/debug-chat/state-tree";
import { useUi } from "@lianki/ui-state";
import { type PaletteItem, type PaletteKind, asUrl, fill, rank, treeItems } from "../nav-core";
import { navPins, navUi } from "../ui-store";
import type { NavText } from "./text";

const KIND_ICON: Record<PaletteKind, IconName> = {
  go: "caretRight",
  create: "plus",
  list: "folderSimple",
  word: "textAa",
  card: "cards",
  tree: "mapTrifold",
  url: "link",
};

/** The Create sheet's entries, shared with the palette. */
export function createItems(t: NavText): PaletteItem[] {
  return [
    {
      id: "create:deck",
      kind: "create",
      title: t.wordsFromDeck,
      href: "/words/import",
      keys: "apkg anki",
    },
    { id: "create:link", kind: "create", title: t.addLink, href: "#link", keys: "url" },
    {
      id: "create:import",
      kind: "create",
      title: t.importCards,
      href: "/import",
      keys: "apkg yaml",
    },
    { id: "create:ai", kind: "create", title: t.aiWords, href: "/ai-vocab", keys: "ai" },
  ];
}

type CachedList = { id: string; name: string; lang?: string; source?: string | null };
type CachedSession = { listId: string; due: { term: string; back?: string }[] };
type CardRow = { url: string; title?: string };

const plain = (s: string | undefined) =>
  (s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

function useLocalItems(open: boolean, t: NavText): PaletteItem[] {
  const [items, setItems] = useState<PaletteItem[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const [lists, sessions] = await Promise.all([
        idbGet<CachedList[]>("lists", "all").catch(() => undefined),
        idbAll<CachedSession>("sessions").catch(() => [] as CachedSession[]),
      ]);
      if (!alive) return;
      const out: PaletteItem[] = [];
      for (const l of lists ?? [])
        out.push({
          id: `list:${l.id}`,
          kind: "list",
          title: l.name,
          sub: t.groupWords,
          href: `/words?list=${encodeURIComponent(l.id)}`,
          keys: l.lang,
        });
      const seen = new Set<string>();
      for (const s of sessions)
        for (const w of s.due ?? []) {
          if (out.length > 600 || seen.has(w.term)) continue;
          seen.add(w.term);
          out.push({
            id: `word:${s.listId}:${w.term}`,
            kind: "word",
            title: w.term,
            sub: plain(w.back),
            href: `/words?list=${encodeURIComponent(s.listId)}`,
          });
        }
      setItems(out);
    })();
    return () => {
      alive = false;
    };
  }, [open, t.groupWords]);
  return items;
}

function useTreeItems(open: boolean, debug: boolean): PaletteItem[] {
  const [items, setItems] = useState<PaletteItem[]>([]);
  useEffect(() => {
    if (!open || !debug || items.length) return;
    let alive = true;
    fetch("/api/dev/state-tree", { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((md) => alive && md && setItems(treeItems(parseTree(md), "/dev/roadmap")))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, debug, items.length]);
  return items;
}

/** Cards matching `q` on the server, 250 ms after typing stops. */
function useCardItems(q: string, signedIn: boolean): [PaletteItem[], boolean] {
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (!signedIn || query.length < 2 || asUrl(query)) {
      setItems([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const p = new URLSearchParams({
          q: query,
          size: "6",
          page: "0",
          sort: "due",
          order: "asc",
          due: "all",
        });
        const r = await fetch(`/api/fsrs/list?${p}`);
        const data = r.ok ? ((await r.json()) as { rows?: CardRow[] }) : {};
        if (alive)
          setItems(
            (data.rows ?? []).map((c) => ({
              id: `card:${c.url}`,
              kind: "card" as const,
              title: c.title || c.url,
              sub: c.url,
              href: c.url,
            })),
          );
      } catch {
        if (alive) setItems([]);
      } finally {
        if (alive) setBusy(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      setBusy(false);
    };
  }, [q, signedIn]);
  return [items, busy];
}

export function SearchPalette({
  open,
  mode,
  onClose,
  onCreateLink,
  t,
  signedIn,
  debug,
}: {
  open: boolean;
  /** "link": opened from Create → Add a link; the hint asks for a URL. */
  mode: "search" | "link";
  onClose: () => void;
  onCreateLink: () => void;
  t: NavText;
  signedIn: boolean;
  debug: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const recent = useUi(navUi, (s) => s.recent);
  const pinned = useUi(navPins, (s) => s.pinned);
  const local = useLocalItems(open, t);
  const tree = useTreeItems(open, debug);
  const [cards, cardsBusy] = useCardItems(open ? q : "", signedIn);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    // After the sheet is painted, so a phone raises its keyboard for it.
    const id = requestAnimationFrame(() => input.current?.focus());
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", key);
    };
  }, [open, onClose]);

  const pages = useMemo<PaletteItem[]>(
    () =>
      APP_NAV.map((i) => ({
        id: `go:${i.key}`,
        kind: "go",
        title: t.pages[i.key] ?? i.key,
        href: i.href,
        keys: `${i.key} ${i.href}`,
      })),
    [t.pages],
  );
  const pageTitle = (p: string) => pages.find((x) => x.href === p.split("?")[0])?.title ?? p;

  const results = useMemo(() => {
    const url = asUrl(q);
    const top: PaletteItem[] = url
      ? [
          {
            id: "url",
            kind: "url",
            title: fill(t.addThisUrl, { url }),
            href: `/add-note#url=${encodeURIComponent(url)}`,
          },
        ]
      : [];
    if (!q.trim()) {
      const mine = [...pinned, ...recent.filter((p) => !pinned.includes(p))].slice(0, 6);
      return [
        ...mine.map((p) => ({
          id: `recent:${p}`,
          kind: "go" as const,
          title: pageTitle(p),
          sub: p,
          href: p,
        })),
        ...pages.filter((p) => !mine.includes(p.href)),
        ...createItems(t),
      ];
    }
    return [...top, ...rank([...pages, ...createItems(t), ...local, ...tree], q, 40), ...cards];
    // pageTitle reads pages, listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pages, local, tree, cards, recent, pinned, t]);

  useEffect(() => setSel(0), [q]);

  if (!open) return null;

  const go = (it: PaletteItem) => {
    if (it.href === "#link") {
      onCreateLink();
      setQ("");
      input.current?.focus();
      return;
    }
    onClose();
    if (/^https?:/i.test(it.href)) window.open(it.href, "_blank", "noopener");
    // /add-note reads its hash once, on load: a full navigation.
    else if (it.href.startsWith("/add-note#")) window.location.assign(it.href);
    else router.push(it.href);
  };

  const groupOf = (k: PaletteKind) =>
    k === "go"
      ? t.groupGo
      : k === "create" || k === "url"
        ? t.create
        : k === "card"
          ? t.groupCards
          : k === "tree"
            ? t.groupTree
            : t.groupWords;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.search}
      className="fixed inset-0 z-50 flex flex-col"
    >
      <button
        type="button"
        aria-label={t.closeSearch}
        onClick={onClose}
        className="absolute inset-0 bg-[oklch(0.2_0.01_65/0.28)] dark:bg-[oklch(0_0_0/0.45)]"
      />
      <div className="lk-glass relative mx-2 mt-[calc(env(safe-area-inset-top)+0.5rem)] flex max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] flex-col overflow-hidden rounded-3xl border border-[var(--glass-line)] shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_20px_50px_-12px_oklch(0.22_0.015_65/0.45)] dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.1),0_20px_50px_-12px_oklch(0_0_0/0.7)] md:mx-auto md:mt-24 md:w-[36rem]">
        <div className="flex items-center gap-2 border-b border-[var(--glass-line)] px-4">
          <Icon
            name={mode === "link" ? "link" : "magnifyingGlass"}
            className="text-xl opacity-70"
          />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter" && results[sel]) {
                e.preventDefault();
                go(results[sel]);
              }
            }}
            type="search"
            enterKeyHint="go"
            autoComplete="off"
            spellCheck={false}
            placeholder={mode === "link" ? t.pasteLink : t.searchPlaceholder}
            aria-label={t.search}
            className="h-14 min-w-0 flex-1 bg-transparent [&::-webkit-search-cancel-button]:hidden text-base outline-none placeholder:text-current placeholder:opacity-50"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t.closeSearch}
            className="-me-2 flex h-11 w-11 items-center justify-center rounded-full text-xl opacity-70 hover:opacity-100"
          >
            <Icon name="x" />
          </button>
        </div>
        <ul
          role="listbox"
          aria-label={t.search}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        >
          {results.map((it, i) => {
            const head = i === 0 || groupOf(results[i - 1].kind) !== groupOf(it.kind);
            return (
              <li key={it.id} role="presentation">
                {head && (
                  <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide opacity-60">
                    {groupOf(it.kind)}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onPointerEnter={() => setSel(i)}
                  onClick={() => go(it)}
                  className={`flex min-h-12 w-full items-center gap-3 px-4 py-2 text-start ${i === sel ? "bg-[oklch(from_var(--foreground)_l_c_h/0.07)]" : ""}`}
                >
                  <Icon name={KIND_ICON[it.kind]} className="text-lg opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.95rem]">{it.title}</span>
                    {it.sub && <span className="block truncate text-xs opacity-60">{it.sub}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {!results.length && (
            <li className="px-4 py-6 text-center text-sm opacity-60">
              {cardsBusy ? t.loading : t.noResults}
            </li>
          )}
          {cardsBusy && results.length > 0 && (
            <li className="px-4 py-2 text-xs opacity-50">{t.loading}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
