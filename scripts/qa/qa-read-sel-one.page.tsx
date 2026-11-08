// The page side of qa-read-sel-one.ts: the reader's selection hook
// (use-reader-select.ts) over a small book, mounted the way ReaderV2 mounts it.
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { useReaderSelect } from "@/app/(app)/reader/[id]/use-reader-select";
import { COMBO_MS, type ComboCtx } from "@/lib/read/reader-select";

const PARAS = [
  "the gift of the magi was a story about love and sacrifice",
  "one dollar and eighty seven cents that was all she had",
];
const ctx: ComboCtx = {
  interval: COMBO_MS,
  // Tokens 2-4 of the first paragraph are a phrase (the combo's phrase level).
  phraseAt: (line, t) => (line === 0 && t >= 2 && t <= 4 ? [2, 4] : null),
  chapterAt: () => -1,
  chapterRange: () => null,
};

function Book() {
  const listRef = useRef<HTMLDivElement>(null);
  const sel = useReaderSelect({ listRef, ctx, scrolling: () => false });
  (window as unknown as { __unit: unknown }).__unit = sel.unit;
  return (
    <div ref={listRef} className="lk-book" data-testid="reader-book">
      {PARAS.map((p, line) => (
        <p key={line} data-line={line}>
          <span data-s={0}>
            {p.split(" ").flatMap((w, t) => [
              <span key={t} data-t={t} id={`w${line}-${t}`}>
                {w}
              </span>,
              " ",
            ])}
          </span>
        </p>
      ))}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Book />);
