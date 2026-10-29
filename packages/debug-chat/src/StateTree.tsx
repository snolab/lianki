"use client";

import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
  type Assignee,
  type Frontier,
  type FrontierEntry,
  type ParseOptions,
  type TreeNode,
  type TreeStatus,
  countOpen,
  crumbs,
  filterNeedsOwner,
  frontier,
  parseTreeDoc,
} from "./state-tree";

/**
 * The state tree, read-only (state-tree.ts has the syntax): collapsible
 * branches, a status glyph (open, in progress, blocked, done), a "needs you"
 * badge on `(!)` items, assignees, a copy button for each action, linked PRs,
 * counts on collapsed branches, the frontier rows (✓ ▶ ›) highlighted, and a
 * "Needs me" toggle (remembered on this device) that keeps only the `(!)`
 * items and their ancestors. It looks like the chat log: plain text lines
 * (no boxes, no background; the host's container gives the halo), indented
 * by depth; each line takes taps (pointer-events: auto) and the small
 * controls have a 40px invisible hit area. Light and dark.
 * Generic: the host passes the strings (English defaults), locale and repo.
 *
 * FrontierLines is the three-line summary (✓ done, ▶ in progress, › next)
 * for a small space such as the chat's minimized bar.
 */

export type TreeStrings = {
  /** The menu entry and the view's heading. */
  tree: string;
  back: string;
  needsMe: string;
  /** On a `(!)` item. */
  needsYou: string;
  /** On a collapsed branch: "{n} open", "{n} need you". */
  openCount: string;
  needsYouCount: string;
  copy: string;
  copied: string;
  expand: string;
  collapse: string;
  loading: string;
  failed: string;
  empty: string;
  nothingNeedsYou: string;
  /** The human owner as an assignee. */
  you: string;
  open: string;
  doing: string;
  blocked: string;
  done: string;
  /** The frontier lines' labels (screen readers, titles). */
  lastDone: string;
  nowDoing: string;
  upNext: string;
  /** The live dot's label. */
  live: string;
};

export const TREE_STRINGS_EN: TreeStrings = {
  tree: "Tree",
  back: "Back to the chat",
  needsMe: "Needs me",
  needsYou: "needs you",
  openCount: "{n} open",
  needsYouCount: "{n} need you",
  copy: "Copy",
  copied: "Copied",
  expand: "Expand",
  collapse: "Collapse",
  loading: "Loading…",
  failed: "Could not load the tree",
  empty: "The tree is empty.",
  nothingNeedsYou: "Nothing waits on you.",
  you: "you",
  open: "open",
  doing: "in progress",
  blocked: "blocked",
  done: "done",
  lastDone: "Last done",
  nowDoing: "In progress",
  upNext: "Up next",
  live: "Live from the dev server",
};

export const treeStrings = (s?: Partial<TreeStrings>): TreeStrings => ({ ...TREE_STRINGS_EN, ...s });

/**
 * Where the tree comes from: a URL (fetched as markdown), a function
 * returning markdown or nodes, or a feed that pushes: `subscribe(onUpdate)`
 * returns its unsubscribe (debug-widget.ts hotTreeSource; later the
 * WebSocket progress feed). `meta.live` marks data from a live source.
 */
export type TreeSource =
  | string
  | (() => string | TreeNode[] | Promise<string | TreeNode[]>)
  | {
      subscribe: (
        onUpdate: (v: string | TreeNode[], meta?: { live?: boolean }) => void,
        onError?: (e: unknown) => void,
      ) => () => void;
    };

const toRoot = (v: string | TreeNode[], opts: ParseOptions): TreeNode =>
  typeof v === "string" ? parseTreeDoc(v, opts) : { title: "", links: [], children: v };

/** Load a URL or function source once into its document root (children: the top-level nodes). */
export async function loadTree(
  source: Exclude<TreeSource, { subscribe: unknown }>,
  opts: ParseOptions = {},
): Promise<TreeNode> {
  let v: string | TreeNode[];
  if (typeof source === "string") {
    const r = await fetch(source, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    v = await r.text();
  } else v = await source();
  return toRoot(v, opts);
}

/** localStorage: "1" while the Needs me filter is on (per device). */
export const NEEDS_ME_KEY = "state-tree:needs-me";

/** The (!) accent: strong in both themes, white text on it. */
const ACCENT = "oklch(0.58 0.21 33)";
const INK: Record<TreeStatus, string> = {
  open: "oklch(0.62 0.03 260)",
  doing: "oklch(0.6 0.16 250)",
  blocked: "oklch(0.7 0.16 70)",
  done: "oklch(0.62 0.15 150)",
};
const LINK_INK = "oklch(0.58 0.15 255)";

const fill = (s: string, n: number) => s.replace("{n}", String(n));

function Svg({ d, size = 16, children }: { d?: string; size?: number; children?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block shrink-0"
      aria-hidden
    >
      {d && <path d={d} />}
      {children}
    </svg>
  );
}
const CHEVRON = "M6 3.5 10.5 8 6 12.5";
const BOX = "M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z";
const FLAG = "M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8";
const COPY =
  "M5.5 5.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-2.5M3 5.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5Z";
const TICK = "M3.5 8.5l3 3 6-7";
const BACK = "M10 3.5 5.5 8 10 12.5";

/** The status box: empty, half filled (in progress), "!" (blocked), ticked (done). */
function StatusGlyph({ status, t }: { status: TreeStatus; t: TreeStrings }) {
  return (
    <span className="mt-[2px]" role="img" aria-label={t[status]} style={{ color: INK[status] }}>
      <Svg d={BOX} size={12}>
        {status === "done" && <path d="M5 8.2l2 2 4-4.4" />}
        {status === "doing" && <path d="M5 5h3v6H5Z" fill="currentColor" stroke="none" />}
        {status === "blocked" && <path d="M8 5v3.6M8 11h.01" />}
      </Svg>
    </span>
  );
}

/** The title with its links (PR refs, URLs) as anchors. */
function Title({ node }: { node: TreeNode }) {
  const parts: ReactNode[] = [];
  let rest = node.title;
  node.links.forEach((l, i) => {
    const at = rest.indexOf(l.text);
    if (at < 0) return;
    parts.push(rest.slice(0, at));
    parts.push(
      <a
        key={i}
        href={l.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="tabular-nums underline decoration-1 underline-offset-2"
        style={{ color: LINK_INK }}
      >
        {l.text}
      </a>,
    );
    rest = rest.slice(at + l.text.length);
  });
  parts.push(rest);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      className="ms-1.5 inline-flex shrink-0 items-center gap-0.5 align-[0.05em] text-[10px] font-semibold"
      style={{ color: ACCENT }}
    >
      {children}
    </span>
  );
}

/** `@name`, or "you" for the human owner. */
function Who({ who, t }: { who?: Assignee; t: TreeStrings }) {
  if (!who) return null;
  return (
    <span
      data-testid="state-tree-assignee"
      title={who.id ? `${who.name}#${who.id}` : who.name}
      className="ms-1.5 whitespace-nowrap text-[10px] opacity-60"
    >
      @{who.type === "human" ? t.you : who.name}
    </span>
  );
}

function CopyButton({ text, t }: { text: string; t: TreeStrings }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      data-testid="state-tree-copy"
      aria-label={done ? t.copied : `${t.copy}: ${text}`}
      title={done ? t.copied : t.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => {},
        );
      }}
      className="relative after:absolute after:-inset-2.5 after:content-[''] ms-1 inline-flex shrink-0 items-center border-0 bg-transparent p-0 align-[-0.15em] text-inherit opacity-60 hover:opacity-100"
      style={done ? { color: INK.done } : undefined}
    >
      <Svg d={done ? TICK : COPY} size={12} />
    </button>
  );
}

function Action({ text, t }: { text: string; t: TreeStrings }) {
  const url = /^https?:\/\/\S+$/.test(text) ? text : null;
  return (
    <div className="pointer-events-auto ps-4 leading-snug">
      <code className="whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" style={{ color: LINK_INK }}>
            {text}
          </a>
        ) : (
          text
        )}
      </code>
      <CopyButton text={text} t={t} />
    </div>
  );
}

type Mark = { glyph: string; color: string; label: string };
/** The frontier rows, keyed by path + title. */
const keyOf = (path: string[], title: string) => [...path, title].join("\u0000");
function frontierMarks(f: Frontier, t: TreeStrings): Map<string, Mark> {
  const m = new Map<string, Mark>();
  const put = (e: FrontierEntry | undefined, mark: Mark) => e && m.set(keyOf(e.path, e.title), mark);
  put(f.done, { glyph: "✓", color: INK.done, label: t.lastDone });
  put(f.next, { glyph: "›", color: INK.open, label: t.upNext });
  put(f.doing, {
    glyph: "▶",
    color: f.doing?.node.needsOwner ? ACCENT : INK.doing,
    label: t.nowDoing,
  });
  return m;
}

type ItemCtx = {
  /** The parent's assignee: a child that only inherits it does not repeat it. */
  parentWho?: Assignee;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  marks: Map<string, Mark>;
  t: TreeStrings;
};

function Item({
  node,
  path,
  titles,
  depth,
  ctx,
}: {
  node: TreeNode;
  path: string;
  titles: string[];
  depth: number;
  ctx: ItemCtx;
}) {
  const { collapsed, onToggle, marks, t } = ctx;
  const branch = node.children.length > 0;
  const shut = branch && collapsed.has(path);
  const counts = shut ? countOpen(node) : null;
  const heading = depth === 0 && !node.status && branch;
  const mark = marks.get(keyOf(titles, node.title));
  // The assignee shows where it is set, not on every child that inherits it.
  const parentWho = ctx.parentWho;
  const who = node.assignee && node.assignee !== parentWho ? node.assignee : undefined;
  const row = (
    <>
      {branch ? (
        <span
          aria-hidden
          className={`mt-[2px] transition-transform motion-reduce:transition-none ${shut ? "" : "rotate-90"}`}
        >
          <Svg d={CHEVRON} size={12} />
        </span>
      ) : (
        <span aria-hidden className="w-3 shrink-0" />
      )}
      {node.status && <StatusGlyph status={node.status} t={t} />}
      <span
        className={`min-w-0 flex-1 break-words ${heading ? "font-semibold" : ""} ${node.status === "done" && !mark ? "opacity-60" : ""} ${mark ? "font-medium" : ""}`}
      >
        {mark && (
          <span
            className="me-1 font-bold"
            title={mark.label}
            aria-label={mark.label}
            style={{ color: mark.color }}
          >
            {mark.glyph}
          </span>
        )}
        <Title node={node} />
        {node.needsOwner && node.status !== "done" && (
          <Badge>
            <Svg d={FLAG} size={10} />
            {t.needsYou}
          </Badge>
        )}
        {!node.needsOwner && <Who who={who} t={t} />}
        {counts && counts.open > 0 && (
          <span className="ms-1.5 whitespace-nowrap text-[10px] tabular-nums opacity-60">
            {fill(t.openCount, counts.open)}
          </span>
        )}
        {counts && counts.needsOwner > 0 && (
          <Badge>
            <Svg d={FLAG} size={10} />
            {fill(t.needsYouCount, counts.needsOwner)}
          </Badge>
        )}
      </span>
    </>
  );
  // A log line: plain text, no box. Only the line itself takes taps.
  const rowClass = "pointer-events-auto flex w-full items-start gap-1 text-start leading-snug";
  const kids: ItemCtx = { ...ctx, parentWho: node.assignee };
  return (
    <li
      data-testid="state-tree-node"
      data-status={node.status}
      data-frontier={mark?.glyph}
      data-needs-owner={node.needsOwner || undefined}
    >
      {branch ? (
        // A div, not a button: the title's links are anchors inside it.
        <div
          role="button"
          tabIndex={0}
          aria-expanded={!shut}
          aria-label={`${shut ? t.expand : t.collapse}: ${node.title}`}
          onClick={() => onToggle(path)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onToggle(path);
          }}
          className={`${rowClass} cursor-pointer select-none`}
        >
          {row}
        </div>
      ) : (
        <div className={rowClass}>
          {row}
        </div>
      )}
      {node.note && (
        <p className="m-0 whitespace-pre-line ps-4 leading-snug opacity-60">{node.note}</p>
      )}
      {node.action?.split("\n").map((a, i) => (
        <Action key={i} text={a} t={t} />
      ))}
      {branch && !shut && (
        <ul className="m-0 list-none space-y-0.5 p-0 ps-3">
          {node.children.map((c, i) => (
            <Item
              key={`${i}:${c.title}`}
              node={c}
              path={`${path}.${i}`}
              titles={node.title ? [...titles, node.title] : titles}
              depth={depth + 1}
              ctx={kids}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

/** A document root from whichever input was given. */
function rootOf(root?: TreeNode, nodes?: TreeNode[], markdown?: string, repo?: string): TreeNode {
  if (root) return root;
  if (nodes) return { title: "", links: [], children: nodes };
  return parseTreeDoc(markdown ?? "", { repo });
}

/**
 * The outline, from `root` (parseTreeDoc), `nodes`, or `markdown` (parsed
 * with `repo`). `onBack` adds a back control to its header (the chat
 * widget's tree view). `locale` picks the ≈ summaries.
 */
export function StateTree({
  root,
  nodes,
  markdown,
  repo,
  locale,
  strings,
  onBack,
  status,
  live = false,
  storageKey = NEEDS_ME_KEY,
}: {
  root?: TreeNode;
  nodes?: TreeNode[];
  markdown?: string;
  repo?: string;
  locale?: string;
  strings?: Partial<TreeStrings>;
  onBack?: () => void;
  /** Shown in place of the outline (loading, or why it failed). */
  status?: string;
  /** The data is live (hot dev source): a small dot in the header. */
  live?: boolean;
  storageKey?: string;
}) {
  const t = treeStrings(strings);
  const doc = rootOf(root, nodes, markdown, repo);
  const all = doc.children;
  // Read after mount: the server render has no localStorage.
  const [needsMe, setNeedsMe] = useState(false);
  useEffect(() => setNeedsMe(readFlag(storageKey)), [storageKey]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const shown = needsMe ? filterNeedsOwner(all) : all;
  const toggleNeedsMe = () => {
    const v = !needsMe;
    setNeedsMe(v);
    try {
      localStorage.setItem(storageKey, v ? "1" : "0");
    } catch {}
  };
  const onToggle = (p: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (!n.delete(p)) n.add(p);
      return n;
    });
  /** Every open (!) item. */
  const total = countOpen(doc).needsOwner;
  const ctx: ItemCtx = { collapsed, onToggle, marks: frontierMarks(frontier(doc, { locale }), t), t };
  return (
    <div data-testid="state-tree" className="space-y-0.5 text-xs leading-snug">
      <div className="pointer-events-auto flex items-center gap-2">
        {onBack && (
          <button
            type="button"
            data-testid="state-tree-back"
            aria-label={t.back}
            title={t.back}
            onClick={onBack}
            className="relative inline-flex shrink-0 items-center border-0 bg-transparent p-0 text-inherit after:absolute after:-inset-2.5 after:content-['']"
          >
            <Svg d={BACK} size={12} />
          </button>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold">
          <span className="truncate">{t.tree}</span>
          {live && (
            <span
              data-testid="state-tree-live"
              role="img"
              aria-label={t.live}
              title={t.live}
              className="size-1.5 shrink-0 animate-pulse rounded-full"
              style={{ background: INK.done }}
            />
          )}
        </span>
        <button
          type="button"
          data-testid="state-tree-needs-me"
          aria-pressed={needsMe}
          onClick={toggleNeedsMe}
          className={`relative inline-flex shrink-0 items-center gap-0.5 border-0 bg-transparent p-0 text-[10px] font-semibold after:absolute after:-inset-2.5 after:content-[''] ${needsMe ? "underline underline-offset-2" : "opacity-70"}`}
          style={{ color: ACCENT }}
        >
          <Svg d={FLAG} size={10} />
          {needsMe ? "✓ " : ""}
          {t.needsMe}
          {total > 0 && <span className="tabular-nums">· {total}</span>}
        </button>
      </div>
      {status ? (
        <p data-testid="state-tree-status" role="status" className="m-0 opacity-60">
          {status}
        </p>
      ) : shown.length === 0 ? (
        <p className="m-0 opacity-60">{needsMe ? t.nothingNeedsYou : t.empty}</p>
      ) : (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {shown.map((n, i) => (
            <Item key={`${i}:${n.title}`} node={n} path={String(i)} titles={[]} depth={0} ctx={ctx} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Loads a TreeSource: on mount, and again whenever `reload` changes. Never polls. */
export function useTreeSource(source: TreeSource | undefined, reload = 0, repo?: string) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The data came from a live source (a feed that said so). */
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    const fail = (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e));
    if (typeof source === "object") {
      // A feed: it pushes every update itself; resubscribing (reload) refetches.
      const off = source.subscribe((v, meta) => {
        if (!alive) return;
        setRoot(toRoot(v, { repo }));
        setLive(!!meta?.live);
        setError(null);
      }, fail);
      return () => {
        alive = false;
        off();
      };
    }
    loadTree(source, { repo }).then((n) => {
      if (!alive) return;
      setRoot(n);
      setLive(false);
      setError(null);
    }, fail);
    return () => {
      alive = false;
    };
    // `source` may be a fresh function each render: only `reload` reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, repo, typeof source === "function" ? "" : source]);
  return { root, error, live };
}

/** StateTree fed by a TreeSource (the chat bumps `reload` each time its menu opens). */
export function StateTreeFromSource({
  source,
  reload = 0,
  repo,
  strings,
  ...rest
}: {
  source: TreeSource;
  reload?: number;
  repo?: string;
  locale?: string;
  strings?: Partial<TreeStrings>;
  onBack?: () => void;
  storageKey?: string;
}) {
  const t = treeStrings(strings);
  const { root, error, live } = useTreeSource(source, reload, repo);
  return (
    <StateTree
      root={root ?? undefined}
      live={live}
      strings={strings}
      status={error ? `${t.failed} (${error})` : root ? undefined : t.loading}
      {...rest}
    />
  );
}

/**
 * The frontier in three lines — ✓ the most recently done, ▶ in progress, ›
 * next — each a ≈ summary (several items) or one item with its breadcrumb.
 * A group shows its count as 〔N〕 and lists its items on tap (collapsed by
 * default). For the chat's minimized bar; pass `root` from parseTreeDoc or
 * useTreeSource.
 */
export function FrontierLines({
  root,
  locale,
  strings,
  className = "",
}: {
  root: TreeNode | null | undefined;
  locale?: string;
  strings?: Partial<TreeStrings>;
  className?: string;
}) {
  const t = treeStrings(strings);
  const [open, setOpen] = useState<string | null>(null);
  if (!root) return null;
  const f = frontier(root, { locale });
  const lines: [keyof Frontier, string, string, string][] = [
    ["done", "✓", INK.done, t.lastDone],
    ["doing", "▶", f.doing?.node.needsOwner ? ACCENT : INK.doing, t.nowDoing],
    ["next", "›", INK.open, t.upNext],
  ];
  return (
    <div data-testid="frontier-lines" className={`text-xs leading-snug ${className}`}>
      {lines.map(([key, glyph, color, label]) => {
        const e = f[key];
        if (!e) return null;
        const group = e.count > 1 && !!e.summary;
        const text = group ? e.summary : [...e.path.slice(-1), e.title].join(" › ");
        const who = group ? undefined : e.assignee;
        const expanded = group && open === key;
        const body = (
          <>
            <span aria-hidden className="w-3 shrink-0 text-center font-bold" style={{ color }}>
              {glyph}
            </span>
            <span className="sr-only">{label}: </span>
            <span className="min-w-0 truncate">{text}</span>
            {group && (
              <span className="shrink-0 tabular-nums opacity-60" aria-label={String(e.count)}>
                〔{e.count}〕
              </span>
            )}
            {who && (
              <span className="shrink-0 text-[10px] opacity-60">
                @{who.type === "human" ? t.you : who.name}
              </span>
            )}
          </>
        );
        return (
          <div key={key} data-testid={`frontier-${key}`} title={group ? undefined : crumbs([...e.path, e.title])}>
            {group ? (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : key)}
                className="pointer-events-auto flex w-full items-center gap-1 border-0 bg-transparent p-0 text-start text-inherit"
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-1">{body}</div>
            )}
            {expanded && (
              <ul data-testid={`frontier-${key}-items`} className="m-0 list-none p-0 ps-4">
                {e.items.map((it, i) => (
                  <li key={i} className="flex gap-1" title={crumbs(it.path)}>
                    <span className="min-w-0 truncate">{it.title}</span>
                    {it.assignee && (
                      <span className="shrink-0 text-[10px] opacity-60">
                        @{it.assignee.type === "human" ? t.you : it.assignee.name}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
