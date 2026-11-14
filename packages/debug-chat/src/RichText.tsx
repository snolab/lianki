/**
 * A chat line's tree (rich-text.ts) as React elements, and its links. Only
 * tags and attributes that passed the allowlist get here; text is always a
 * text node. Colours in oklch(), through light-dark() for both themes.
 */
import { type CSSProperties, createElement, type ReactNode, useRef, useState } from "react";
import { linkClick, parseLinks, sameTab } from "./chat-links";
import type { Rich, RichNode, RichString } from "./rich-text";
import { ChatLinkMenu } from "./ChatLinkMenu";
import { linkDestinations } from "./link-destination";

const LINK_INK = "light-dark(oklch(0.46 0.187 22.3), oklch(0.8 0.132 22.3))";
const CODE_BG = "light-dark(oklch(0.5 0.01 260 / 0.13), oklch(0.85 0.01 260 / 0.16))";
const RULE = "light-dark(oklch(0.5 0.01 260 / 0.35), oklch(0.85 0.01 260 / 0.35))";

/** A line being read: its sentences, and how to wrap the text of one. */
export type RichRead = {
  ranges: readonly { start: number; end: number }[];
  wrap: (idx: number, key: string, children: ReactNode) => ReactNode;
};

type OpenPage = (path: string) => void;

const here = () => (typeof location === "undefined" ? undefined : location.hostname);

/**
 * One link. At rest the history is click-through (log-engage.ts), so a link
 * takes the pointer itself. A tap or context menu opens the chat's actions;
 * a mouse drag selects text and opens nothing. The click stops here so it
 * never becomes a tap on the message around it.
 */
export function ChatLink({
  href,
  children,
  onOpenPage,
}: {
  href: string;
  children: ReactNode;
  onOpenPage?: OpenPage;
}) {
  const down = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const destinations =
    typeof location === "undefined"
      ? { href, prod: null, forceProd: false }
      : linkDestinations(href, location);
  const stay = sameTab(destinations.href, here());
  const close = () => {
    setMenu(false);
    anchor.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <a
        ref={anchor}
        href={destinations.href}
        {...(stay ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        draggable={false}
        data-testid="debug-chat-link"
        className="pointer-events-auto underline decoration-1 underline-offset-2 [overflow-wrap:anywhere]"
        style={{ color: LINK_INK }}
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          e.stopPropagation();
          const from = down.current;
          down.current = null;
          const did = linkClick({
            href,
            hereHost: here(),
            movedPx: from ? Math.hypot(e.clientX - from.x, e.clientY - from.y) : 0,
            modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
            hasRouter: !!onOpenPage,
          });
          e.preventDefault();
          if (did.to !== "drag") setMenu(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(true);
        }}
        // Enter on a link is the link's, not the compact line's "show all".
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
      >
        {children}
      </a>
      {menu && <ChatLinkMenu {...destinations} onOpenPage={onOpenPage} onClose={close} />}
    </>
  );
}

/** Text, cut where the sentences being read are. */
function textEl(n: RichString, key: string, read?: RichRead): ReactNode {
  if (!read || n.at === undefined) return n.text;
  const from = n.at;
  const to = from + n.text.length;
  const parts: ReactNode[] = [];
  read.ranges.forEach((r, idx) => {
    const a = Math.max(r.start, from);
    const b = Math.min(r.end, to);
    if (a < b) parts.push(read.wrap(idx, `${key}.${r.start}`, n.text.slice(a - from, b - from)));
  });
  return parts.length ? parts : n.text;
}

const CLASS: Record<string, string> = {
  p: "m-0 my-1 first:mt-0 last:mb-0",
  ul: "m-0 my-1 list-disc ps-5",
  ol: "m-0 my-1 list-decimal ps-5",
  blockquote: "m-0 my-1 border-s-2 ps-2 opacity-85",
  hr: "my-1.5 border-0 border-t",
  pre: "m-0 my-1 max-w-full overflow-x-auto whitespace-pre rounded p-2 font-mono fs-11 leading-snug",
  code: "rounded px-1 font-mono text-[0.92em]",
  table: "w-max border-collapse fs-11 leading-snug",
  th: "max-w-96 border px-1.5 py-0.5 text-start font-semibold",
  td: "max-w-96 border px-1.5 py-0.5 align-top",
  img: "h-auto max-w-full rounded",
};
const STYLE: Record<string, CSSProperties> = {
  pre: { background: CODE_BG },
  code: { background: CODE_BG },
  hr: { borderColor: RULE },
  blockquote: { borderColor: RULE },
  th: { borderColor: RULE },
  td: { borderColor: RULE },
};

function nodeEls(
  nodes: RichNode[],
  o: { read?: RichRead; onOpenPage?: OpenPage; inPre?: boolean },
  prefix = "",
): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`;
    if ("text" in n) return <TextPiece key={key}>{textEl(n, key, o.read)}</TextPiece>;
    const { tag, attrs = {} } = n;
    const kids = () => nodeEls(n.children, { ...o, inPre: o.inPre || tag === "pre" }, `${key}.`);
    if (tag === "a")
      return (
        <ChatLink key={key} href={attrs.href!} onOpenPage={o.onOpenPage}>
          {kids()}
        </ChatLink>
      );
    if (tag === "table")
      return (
        // Wide ones scroll here, never widening the page.
        <div key={key} data-testid="debug-chat-table" className="my-1 max-w-full overflow-x-auto">
          <table className={CLASS.table}>{kids()}</table>
        </div>
      );
    const { align, ...rest } = attrs;
    // A code block's <code> takes its look from the <pre>.
    const plainCode = tag === "code" && o.inPre;
    const props = {
      key,
      ...rest,
      className: plainCode ? undefined : CLASS[tag],
      style: plainCode
        ? undefined
        : { ...STYLE[tag], ...(align ? { textAlign: align as CSSProperties["textAlign"] } : {}) },
    };
    if (tag === "img")
      return createElement("img", { ...props, loading: "lazy", referrerPolicy: "no-referrer" });
    if (tag === "br" || tag === "hr") return createElement(tag, props);
    return createElement(tag, props, ...kids());
  });
}

const TextPiece = ({ children }: { children: ReactNode }) => <>{children}</>;

/** A line in full: markdown's blocks, links, and the sentence being read. */
export function RichBody({
  rich,
  read,
  onOpenPage,
}: {
  rich: Rich;
  read?: RichRead;
  onOpenPage?: OpenPage;
}) {
  return <>{nodeEls(rich.nodes, { read, onOpenPage })}</>;
}

/** A line in the one-line views (compact, floating): no blocks, the links still links. */
export function RichLine({ rich, onOpenPage }: { rich: Rich; onOpenPage?: OpenPage }) {
  return (
    <>
      {parseLinks(rich.shown).map((s, i) =>
        s.href ? (
          <ChatLink key={i} href={s.href} onOpenPage={onOpenPage}>
            {s.text}
          </ChatLink>
        ) : (
          s.text
        ),
      )}
    </>
  );
}
