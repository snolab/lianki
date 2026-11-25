// Preloaded before every `bun test` run (bunfig.toml, [test] preload), before
// globals-guard.ts takes its baseline.
//
// react-dom/client decides once, when the module is first evaluated, whether
// the `input` event exists (`canUseDOM && isEventSupported("input")`). When
// that first evaluation happens with no `window`/`document`, it records "no",
// and from then on a controlled <input>'s onChange never fires for
// input/change events. The whole suite runs in one process and shares the
// module cache, so one file that imports react-dom/client at the top
// (before it stubs a happy-dom window, e.g. chat-fullscreen-menu.test.tsx)
// breaks every later file that types into an input (token-scope-ui,
// presence-stack). Which files come later depends on the directory order,
// which differs between this Mac and Linux, so CI failed while local runs
// passed.
//
// Evaluating react-dom/client here, with a throwaway happy-dom window, makes
// that check come out the same for every file in any order. The window and
// document globals are then put back exactly as they were.

import { Window } from "happy-dom";
import { stubGlobals } from "./globals";

const win = new Window();
const restore = stubGlobals({ window: win, document: win.document });
try {
  await import("react-dom/client");
} finally {
  restore();
  await win.happyDOM.close();
}
