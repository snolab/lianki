/**
 * One collapsed row of read-aloud echoes in the chat (docs/echo-suppression.md,
 * "UI"): a speaker icon, "Read aloud, heard back" (or "{n} read-aloud
 * echoes"), the first words dimmed. A tap expands it: each echo's full text, a
 * link to the line it echoed, a dev holder's layer and score, and "This was
 * me", which posts the line as his after all (the hub's unmerge / restoreEcho).
 * Grouping and the frames are echo-rows.ts.
 */
import { useState } from "react";
import { echoDevNote, echoHead } from "./echo-rows";
import { Disclosure, Icon } from "./icons";
import type { ChatMessage } from "./wire";

export type EchoRowStrings = {
  echoHeard: string;
  echoMany: string;
  echoMine: string;
  echoOf: string;
};

/** Scroll the chat to a line (the one an echo copied), if it is shown. */
export function jumpToLine(id: string, root: ParentNode | null = globalThis.document ?? null) {
  if (!root) return false;
  let el: HTMLElement | null | undefined;
  try {
    const esc = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    el = root.querySelector?.<HTMLElement>(`[data-testid=debug-chat-line][data-msg="${esc}"]`);
  } catch {
    return false;
  }
  if (!el) return false;
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return true;
}

export function EchoRow({
  lines,
  t,
  dev = false,
  onMine,
  onJump = (id) => void jumpToLine(id),
}: {
  lines: readonly ChatMessage[];
  t: EchoRowStrings;
  /** A dev holder sees which evidence and how alike. */
  dev?: boolean;
  onMine?: (id: string) => void;
  onJump?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  const label = lines.length > 1 ? t.echoMany.replace("{n}", String(lines.length)) : t.echoHeard;
  return (
    <li
      data-testid="debug-chat-echo"
      data-count={lines.length}
      data-open={open || undefined}
      className="leading-snug"
    >
      <button
        type="button"
        data-testid="debug-chat-echo-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-h-6 cursor-pointer items-center gap-1.5 rounded px-1 text-start text-xs text-[oklch(0.55_0_0)] hover:bg-[oklch(0.5_0_0/0.06)]"
      >
        <Icon name="speakerHigh" />
        <span className="shrink-0 font-medium">{label}</span>
        {!open && (
          <span data-testid="debug-chat-echo-head" className="min-w-0 truncate opacity-60">
            {echoHead(lines[0]!.text)}
          </span>
        )}
        <span className="ms-auto shrink-0">
          <Disclosure open={open} size={10} />
        </span>
      </button>
      {open && (
        <ul className="m-0 list-none space-y-1 py-1 ps-6 pe-1 text-xs">
          {lines.map((m) => (
            <li key={m.id} data-testid="debug-chat-echo-line" data-msg={m.id}>
              <p className="m-0 whitespace-pre-wrap break-words text-[oklch(0.5_0_0)]">{m.text}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                {m.echo?.of ? (
                  <button
                    type="button"
                    data-testid="debug-chat-echo-of"
                    onClick={() => onJump(m.echo!.of)}
                    className="cursor-pointer underline decoration-dotted text-[oklch(0.55_0_0)]"
                  >
                    {t.echoOf}
                  </button>
                ) : null}
                {dev && (
                  <span data-testid="debug-chat-echo-dev" className="font-mono opacity-60">
                    {echoDevNote(m)}
                  </span>
                )}
                {onMine && (
                  <button
                    type="button"
                    data-testid="debug-chat-echo-mine"
                    onClick={() => onMine(m.id)}
                    className="ms-auto min-h-6 cursor-pointer rounded border border-[oklch(0.55_0.17_27)] px-2 font-medium text-[oklch(0.5_0.17_27)]"
                  >
                    {t.echoMine}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
