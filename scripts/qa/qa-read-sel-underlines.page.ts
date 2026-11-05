// The page side of qa-read-sel-underlines.ts: selects the first two words the
// way use-reader-select.ts draws a selection, and says which way it took.
import { keepsDecorations } from "@/app/(app)/read/[id]/use-reader-select";

(window as unknown as { __select(): string }).__select = () => {
  const els = [document.getElementById("in1")!, document.getElementById("in2")!];
  if (typeof Highlight !== "undefined" && "highlights" in CSS && keepsDecorations()) {
    const r = document.createRange();
    r.setStartBefore(els[0]);
    r.setEndAfter(els[1]);
    CSS.highlights.set("lk-sel", new Highlight(r));
    return "highlight";
  }
  for (const e of els) e.setAttribute("data-sel", "");
  return "data-sel";
};
