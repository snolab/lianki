"use client";

/**
 * A roadmap doc step's Markdown, rendered as React elements from marked's
 * tokens (no HTML string, so nothing the learner writes runs as markup).
 * Task items `- [ ]` / `- [x]` are real checkboxes numbered in document
 * order, the same order lib/roadmap/doc-checklist.ts counts and toggles.
 * Images show only from the learner's own files (/api/my/files/…) or https.
 */
import { Fragment, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

type Props = {
  markdown: string;
  onToggle?: (index: number, checked: boolean) => void;
  disabled?: boolean;
};

const safeHref = (h: string) => /^(https?:|mailto:|\/(?!\/))/i.test(h.trim());
const safeImg = (s: string) => /^(https:\/\/|\/api\/my\/files\/)/i.test(s.trim());

export default function DocMarkdown({ markdown, onToggle, disabled }: Props) {
  const tokens = Lexer.lex(markdown, { gfm: true });
  // Task items in document order (pre-order: an item before its nested ones).
  const index = new Map<Tokens.ListItem, number>();
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      if (t.type === "list") {
        for (const it of (t as Tokens.List).items) {
          if (it.task) index.set(it, index.size);
          walk(it.tokens);
        }
      } else if (t.type === "blockquote") walk((t as Tokens.Blockquote).tokens);
    }
  };
  walk(tokens);

  const inline = (ts: Token[] | undefined, k = ""): ReactNode =>
    (ts ?? []).map((t, i) => {
      const key = `${k}${i}`;
      switch (t.type) {
        case "strong":
          return <strong key={key}>{inline((t as Tokens.Strong).tokens, key)}</strong>;
        case "em":
          return <em key={key}>{inline((t as Tokens.Em).tokens, key)}</em>;
        case "del":
          return <del key={key}>{inline((t as Tokens.Del).tokens, key)}</del>;
        case "codespan":
          return (
            <code key={key} className="rounded bg-gray-100 px-1 dark:bg-gray-800">
              {(t as Tokens.Codespan).text}
            </code>
          );
        case "br":
          return <br key={key} />;
        case "link": {
          const l = t as Tokens.Link;
          return safeHref(l.href) ? (
            <a
              key={key}
              href={l.href}
              target={l.href.startsWith("/") ? undefined : "_blank"}
              rel="noopener noreferrer"
              className="text-blue-600 underline dark:text-blue-300"
            >
              {inline(l.tokens, key)}
            </a>
          ) : (
            <Fragment key={key}>{inline(l.tokens, key)}</Fragment>
          );
        }
        case "image": {
          const im = t as Tokens.Image;
          return safeImg(im.href) ? (
            // eslint-disable-next-line @next/next/no-img-element -- the learner's own file, any size
            <img
              key={key}
              src={im.href}
              alt={im.text}
              loading="lazy"
              className="my-2 block h-auto max-w-full rounded-lg"
            />
          ) : (
            <Fragment key={key}>{im.text}</Fragment>
          );
        }
        case "checkbox":
          return null;
        case "text": {
          const tx = t as Tokens.Text;
          return tx.tokens ? (
            <Fragment key={key}>{inline(tx.tokens, key)}</Fragment>
          ) : (
            <Fragment key={key}>{tx.text}</Fragment>
          );
        }
        case "escape":
          return <Fragment key={key}>{(t as Tokens.Escape).text}</Fragment>;
        default:
          return <Fragment key={key}>{"raw" in t ? String(t.raw) : ""}</Fragment>;
      }
    });

  const block = (ts: Token[], k = ""): ReactNode =>
    ts.map((t, i) => {
      const key = `${k}${i}`;
      switch (t.type) {
        case "space":
          return null;
        case "heading": {
          const h = t as Tokens.Heading;
          const cls = h.depth <= 2 ? "text-base font-semibold mt-3" : "text-sm font-semibold mt-2";
          return (
            <p key={key} role="heading" aria-level={Math.min(6, h.depth + 2)} className={cls}>
              {inline(h.tokens, key)}
            </p>
          );
        }
        case "paragraph":
          return (
            <p key={key} className="my-1.5">
              {inline((t as Tokens.Paragraph).tokens, key)}
            </p>
          );
        case "code":
          return (
            <pre
              key={key}
              className="my-2 overflow-x-auto rounded-lg bg-gray-100 p-2 text-xs dark:bg-gray-800"
            >
              <code>{(t as Tokens.Code).text}</code>
            </pre>
          );
        case "blockquote":
          return (
            <blockquote
              key={key}
              className="my-2 border-s-2 border-gray-300 ps-3 text-gray-600 dark:border-gray-600 dark:text-gray-300"
            >
              {block((t as Tokens.Blockquote).tokens, key)}
            </blockquote>
          );
        case "hr":
          return <hr key={key} className="my-3 border-gray-200 dark:border-gray-700" />;
        case "list": {
          const l = t as Tokens.List;
          const items = l.items.map((it, j) => {
            const n = index.get(it);
            const body = it.tokens.map((c, ci) =>
              c.type === "text" && !l.loose ? (
                <Fragment key={ci}>
                  {inline((c as Tokens.Text).tokens ?? [c], `${key}.${j}.${ci}`)}
                </Fragment>
              ) : c.type === "checkbox" ? null : (
                <Fragment key={ci}>{block([c], `${key}.${j}.${ci}`)}</Fragment>
              ),
            );
            if (n === undefined) return <li key={j}>{body}</li>;
            return (
              <li key={j} className="list-none -ms-5">
                <label className="flex min-h-10 cursor-pointer items-start gap-2 py-1">
                  <input
                    type="checkbox"
                    data-doc-check={n}
                    checked={!!it.checked}
                    disabled={disabled || !onToggle}
                    onChange={(e) => onToggle?.(n, e.target.checked)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600"
                  />
                  <span
                    className={`min-w-0 flex-1 ${it.checked ? "text-gray-500 line-through dark:text-gray-400" : ""}`}
                  >
                    {body}
                  </span>
                </label>
              </li>
            );
          });
          return l.ordered ? (
            <ol
              key={key}
              start={typeof l.start === "number" ? l.start : undefined}
              className="my-1.5 list-decimal ps-5"
            >
              {items}
            </ol>
          ) : (
            <ul key={key} className="my-1.5 list-disc ps-5">
              {items}
            </ul>
          );
        }
        case "table": {
          const tb = t as Tokens.Table;
          return (
            <div key={key} className="my-2 overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr>
                    {tb.header.map((c, ci) => (
                      <th
                        key={ci}
                        className="border-b border-gray-200 px-2 py-1 text-start dark:border-gray-700"
                      >
                        {inline(c.tokens, `${key}h${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci} className="px-2 py-1">
                          {inline(c.tokens, `${key}r${ri}c${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        case "html":
          // Shown as the text it is, never as markup.
          return (
            <p key={key} className="my-1.5 whitespace-pre-wrap">
              {(t as Tokens.HTML).text}
            </p>
          );
        default:
          return "tokens" in t && Array.isArray(t.tokens) ? (
            <p key={key}>{inline(t.tokens as Token[], key)}</p>
          ) : (
            <p key={key}>{"text" in t ? String(t.text) : ""}</p>
          );
      }
    });

  return (
    <div
      data-doc-markdown
      className="text-sm leading-relaxed text-gray-800 dark:text-gray-200 break-words"
    >
      {block(tokens)}
    </div>
  );
}
