/**
 * The hot-island loader (docs/dev-hot-islands.md), with every dependency
 * passed in; page.ts wires the real ones.
 *
 * It shares the page's modules on globalThis.__lkModules, imports the
 * islands module, installs the islands this page knows (matching contract
 * versions) into the store, and holds one EventSource to the dev server: on
 * `slot-reload {rev, names}` it re-imports with `?v=<rev>` and replaces only
 * those islands (`names: []` = all), so everything else keeps its state. Event-driven: no polling.
 */
import { ISLAND_VERSIONS } from "./contract";
import {
  MODULES_GLOBAL,
  checkIslandsModule,
  errLine,
  islandsEventsUrl,
  islandsUrl,
  parseReload,
} from "./rules";
import type { IslandStore, Override } from "./store";

type Status = { active: boolean; rev: string; names: string[]; note: string };
/** The part of EventSource the loader uses. */
type ES = { addEventListener(type: string, fn: (e: MessageEvent) => void): void; close(): void };

export type LoaderDeps = {
  src: URL;
  store: IslandStore;
  importer: (url: string) => Promise<Record<string, unknown>>;
  modules: () => Promise<Record<string, unknown>>;
  eventSource: (url: string) => ES;
  setCss: (css: string | null) => void;
  status: (s: Status) => void;
  onReload: (fn: () => void) => () => void;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
};

/** Start loading islands from `src`; returns stop, which puts every island back to built in. */
export function startIslands(d: LoaderDeps): () => void {
  let live = true;
  let rev = "";
  let shared = false;
  const load = async (r: string, names?: string[]) => {
    try {
      if (!shared) {
        (globalThis as Record<string, unknown>)[MODULES_GLOBAL] = await d.modules();
        shared = true;
      }
      const m = checkIslandsModule<Override["C"]>(
        await d.importer(islandsUrl(d.src, r)),
        ISLAND_VERSIONS,
      );
      if (!live) return;
      rev = m.rev || r;
      d.setCss(m.css);
      const next: Record<string, Override> = {};
      for (const [name, C] of Object.entries(m.islands))
        if (!names?.length || names.includes(name)) next[name] = { C, rev };
      d.store.put(next);
      const skipped = m.skipped.length ? ` · skipped ${m.skipped.join("; ")}` : "";
      d.status({
        active: true,
        rev,
        names: d.store.names(),
        note: `islands: ${d.src.host} · ${rev || "first"}${skipped}`,
      });
      d.log({ ev: "islands-loaded", rev, names: Object.keys(next), skipped: m.skipped });
    } catch (e) {
      if (!live) return;
      const note = `islands failed (${errLine(e)}); built-in islands stay`;
      d.status({ active: d.store.names().length > 0, rev, names: d.store.names(), note });
      d.log({ ev: "islands-failed", error: errLine(e) });
    }
  };
  void load("");
  const es = d.eventSource(islandsEventsUrl(d.src));
  es.addEventListener("hello", (e) => {
    const r = String((e as MessageEvent).data);
    // Rebuilt while the stream was down: catch up.
    if (rev && r && r !== rev) void load(r);
  });
  es.addEventListener("slot-reload", (e) => {
    const p = parseReload(String((e as MessageEvent).data));
    if (p) void load(p.rev, p.names);
  });
  const offReload = d.onReload(() => void load(`${rev}.${(d.now ?? Date.now)().toString(36)}`));
  return () => {
    live = false;
    es.close();
    offReload();
    d.store.clear();
    d.setCss(null);
    d.status({ active: false, rev: "", names: [], note: "" });
  };
}
