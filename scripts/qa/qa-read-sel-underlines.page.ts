// The page side of qa-read-sel-underlines.ts: selects the first two words the
// way use-reader-select.ts draws a selection (markSelected: [data-sel] on the
// elements), and says which way it took.
import { markSelected } from "@/lib/read/select-mark";

(window as unknown as { __select(): string }).__select = () => {
  markSelected(document, [document.getElementById("in1")!, document.getElementById("in2")!]);
  return "data-sel";
};
