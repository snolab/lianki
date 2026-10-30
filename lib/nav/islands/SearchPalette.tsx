"use client";

/**
 * The command palette (docs/bottom-nav.md, "Search"). Progressive:
 *
 * 1. at once, on every keystroke: the app's own pages and commands (static);
 * 2. then his own content from the on-device index (lib/nav/islands/
 *    search-idb.ts): lists, words, cards, study plan, state tree — each
 *    group appended below the ones shown, never reordering them. A newer
 *    keystroke cancels the round in progress (a generation counter).
 *
 * Nothing typed here leaves the device. The last row opens AnkiWeb's own
 * search in a new tab. Modal: role="dialog", Escape or the backdrop closes it.
 */
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/app/components/icons";
import { APP_NAV } from "@/lib/app-nav";
import { ANKIWEB_SEARCH_URL } from "@/lib/words/ankiweb";
import { useUi } from "@lianki/ui-state";
import { type PaletteItem, asUrl, fill, highlight, norm, rank } from "../nav-core";
import { type DocKind, GROUP_ORDER, type SearchDoc, scan } from "../search-docs";
import { navPins, navUi } from "../ui-store";
import { INDEX_EVENT, anchorWord, loadDocs, syncIndex } from "./search-idb";
import { type NavText, str } from "./text";

type Kind = PaletteItem["kind"] | DocKind | "plan" | "more" | "ankiweb";

const KIND_ICON: Record<Kind, IconName> = {
  go: "caretRight",
  create: "plus",
  list: "folderSimple",
  word: "textAa",
  card: "cards",
  tree: "mapTrifold",
  plan: "mapTrifold",
  url: "link",
  more: "magnifyingGlass",
  ankiweb: "globe",
};

/** The Create sheet's entries, shared with the palette. */
export function createItems(t: NavText): PaletteItem[] {
  return [
    { id: "create:link", kind: "create", title: t.addLink, href: "#link", keys: "url" },
    {
      id: "create:deck",
      kind: "create",
      title: t.wordsFromDeck,
      href: "/words/import",
      keys: "apkg anki",
    },
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

/** One row on screen. */
type Row = { id: string; kind: Kind; title: string; sub?: string; href: string; doc?: SearchDoc };
type Group = { kind: Kind; label: string; rows: Row[] };

const fromDoc = (d: SearchDoc): Row => ({
  id: d.id,
  kind: d.kind,
  title: d.title,
  sub: d.sub,
  href: d.href,
  doc: d,
});

function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map(([part, hit], i) =>
        hit ? (
          <mark
            key={i}
            className="rounded-sm bg-[oklch(from_var(--brand)_l_c_h/0.18)] text-inherit [text-shadow:none]"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
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
  const anki = useIntlayer("words-import-ankiweb") as unknown as Record<string, unknown>;
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const recent = useUi(navUi, (s) => s.recent);
  const pinned = useUi(navPins, (s) => s.pinned);
  /** Async groups for the current query, in GROUP_ORDER, appended as they come. */
  const [found, setFound] = useState<{
    q: string;
    groups: Group[];
    done: boolean;
    capped: boolean;
  }>({
    q: "",
    groups: [],
    done: true,
    capped: false,
  });
  const gen = useRef(0);
  /** Bumped when the index changes, to search again. */
  const [rev, setRev] = useState(0);

  const groupLabel = useCallback(
    (k: Kind) =>
      k === "list"
        ? t.pages.words
        : k === "word"
          ? t.groupWords
          : k === "card"
            ? t.groupCards
            : k === "plan"
              ? t.pages.roadmap
              : k === "tree"
                ? t.groupTree
                : k === "go"
                  ? t.groupGo
                  : t.create,
    [t],
  );

  // Opening: keep the index up to date (only changed sources are rebuilt).
  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    const id = requestAnimationFrame(() => input.current?.focus());
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const changed = () => setRev((r) => r + 1);
    document.addEventListener("keydown", key);
    window.addEventListener(INDEX_EVENT, changed);
    void syncIndex({ signedIn, debug, listsLabel: t.pages.words });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", key);
      window.removeEventListener(INDEX_EVENT, changed);
    };
  }, [open, onClose, signedIn, debug, t.pages.words]);

  // (2) His content, group by group, off the input's path.
  useEffect(() => {
    const g = ++gen.current;
    const n = norm(q.trim());
    if (!open || !n) {
      setFound({ q, groups: [], done: true, capped: false });
      return;
    }
    setFound((f) => (f.q === q ? f : { q, groups: [], done: false, capped: false }));
    const cancelled = () => g !== gen.current;
    void (async () => {
      const { docs, capped } = await loadDocs();
      const groups: Group[] = [];
      for (const kind of GROUP_ORDER) {
        if (cancelled()) return;
        const hits = await scan(docs.get(kind) ?? [], n, { cancelled });
        if (!hits) return;
        if (!hits.length) continue;
        groups.push({ kind, label: groupLabel(kind), rows: hits.map(fromDoc) });
        // Append: what is on screen stays where it is.
        setFound({ q, groups: [...groups], done: false, capped });
      }
      if (!cancelled()) setFound({ q, groups, done: true, capped });
    })();
  }, [q, open, rev, groupLabel]);

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

  // (1) The app's own functions: synchronous, every keystroke.
  const head = useMemo<Group[]>(() => {
    const url = asUrl(q);
    const out: Group[] = [];
    if (url)
      out.push({
        kind: "url",
        label: t.create,
        rows: [
          {
            id: "url",
            kind: "url",
            title: fill(t.addThisUrl, { url }),
            href: `/add-note#url=${encodeURIComponent(url)}`,
          },
        ],
      });
    if (!q.trim()) {
      const title = (p: string) => pages.find((x) => x.href === p.split("?")[0])?.title ?? p;
      const mine = [...pinned, ...recent.filter((p) => !pinned.includes(p))].slice(0, 6);
      const rows: Row[] = [
        ...mine.map((p) => ({
          id: `recent:${p}`,
          kind: "go" as const,
          title: title(p),
          sub: p,
          href: p,
        })),
        ...pages.filter((p) => !mine.includes(p.href)),
      ];
      out.push(
        { kind: "go", label: t.groupGo, rows },
        { kind: "create", label: t.create, rows: createItems(t) },
      );
      return out;
    }
    const go = rank(pages, q, 8);
    const make = rank(createItems(t), q, 4);
    if (go.length) out.push({ kind: "go", label: t.groupGo, rows: go });
    if (make.length) out.push({ kind: "create", label: t.create, rows: make });
    return out;
  }, [q, pages, pinned, recent, t]);

  const tail = useMemo<Group[]>(() => {
    const s = q.trim();
    if (!s) return [];
    const rows: Row[] = [];
    if (found.q === q && found.done && found.capped)
      rows.push({
        id: "more",
        kind: "more",
        title: t.searchAllWords || `${t.search} · ${t.groupWords}`,
        href: "#all",
      });
    const more = str(anki.searchMore);
    if (more)
      rows.push({
        id: "ankiweb",
        kind: "ankiweb",
        title: more,
        sub: s,
        href: `${ANKIWEB_SEARCH_URL}${encodeURIComponent(s)}`,
      });
    return rows.length ? [{ kind: "ankiweb", label: "", rows }] : [];
  }, [q, found, t, anki.searchMore]);

  const groups = useMemo(
    () => [...head, ...(found.q === q ? found.groups : []), ...tail],
    [head, found, q, tail],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => setSel(0), [q]);

  if (!open) return null;

  const go = async (it: Row) => {
    if (it.href === "#link") {
      onCreateLink();
      setQ("");
      input.current?.focus();
      return;
    }
    if (it.href === "#all") {
      await syncIndex({ signedIn, debug, all: true, listsLabel: t.pages.words });
      return;
    }
    onClose();
    if (it.doc?.kind === "word" && it.doc.listId && it.doc.term)
      anchorWord(it.doc.listId, it.doc.term);
    if (/^https?:/i.test(it.href)) window.open(it.href, "_blank", "noopener,noreferrer");
    // /add-note reads its hash once, on load: a full navigation.
    else if (it.href.startsWith("/add-note#")) window.location.assign(it.href);
    else router.push(it.href);
  };

  let index = -1;
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
                setSel((s) => Math.min(flat.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter" && flat[sel]) {
                e.preventDefault();
                void go(flat[sel]);
              }
            }}
            type="search"
            enterKeyHint="go"
            autoComplete="off"
            spellCheck={false}
            placeholder={mode === "link" ? t.pasteLink : t.searchPlaceholder}
            aria-label={t.search}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none [&::-webkit-search-cancel-button]:hidden placeholder:text-current placeholder:opacity-50"
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
          aria-busy={found.q === q && !found.done}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        >
          {groups.map((g) => (
            <li key={`${g.kind}:${g.label}`} role="presentation">
              {g.label && (
                <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide opacity-60">
                  {g.label}
                </div>
              )}
              <ul role="presentation">
                {g.rows.map((it) => {
                  const i = ++index;
                  return (
                    <li key={it.id} role="presentation">
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === sel}
                        onPointerEnter={() => setSel(i)}
                        onClick={() => void go(it)}
                        className={`flex min-h-12 w-full items-center gap-3 px-4 py-2 text-start ${i === sel ? "bg-[oklch(from_var(--foreground)_l_c_h/0.07)]" : ""}`}
                      >
                        <Icon name={KIND_ICON[it.kind]} className="text-lg opacity-70" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.95rem]">
                            <Marked text={it.title} q={q} />
                          </span>
                          {it.sub && (
                            <span className="block truncate text-xs opacity-60">
                              <Marked text={it.sub} q={q} />
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {found.q === q && !found.done && q.trim() && (
            <li className="px-4 py-2 text-xs opacity-50" aria-live="polite">
              {t.loading}
            </li>
          )}
          {!flat.length && (
            <li className="px-4 py-6 text-center text-sm opacity-60">{t.noResults}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
