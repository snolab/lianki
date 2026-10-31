/**
 * The hot-island loader with the page's real dependencies
 * (docs/dev-hot-islands.md). Loaded with import() by useIslands only once this
 * page holds a code-run grant and `lk:slots-src` points at an allowed origin;
 * nothing else on the page pulls it (or host-modules.ts) in.
 */
import { devLog } from "@/lib/debug-client";
import { onAction } from "./actions";
import { loadHostModules } from "./host-modules";
import { startIslands } from "./loader";
import { writeShared } from "./shared-state";
import { islandStore } from "./store";

const STYLE_ID = "lk-islands-css";

function setCss(css: string | null) {
  let el = document.getElementById(STYLE_ID);
  if (css === null) return void el?.remove();
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.append(el);
  }
  el.textContent = css;
}

/**
 * A real dynamic import the bundler leaves alone, built on first use in the
 * browser only (Workers refuse code from strings).
 */
const importer = (u: string) =>
  (new Function("u", "return import(u)") as (u: string) => Promise<Record<string, unknown>>)(u);

/** startIslands with the page's real dependencies. */
export function startIslandsInPage(src: URL): () => void {
  return startIslands({
    src,
    store: islandStore,
    importer,
    modules: loadHostModules,
    eventSource: (u) => new EventSource(u),
    setCss,
    status: (s) => writeShared("islands.status", s),
    onReload: (fn) => onAction("islands.reload", fn),
    log: devLog,
  });
}
