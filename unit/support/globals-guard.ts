// Preloaded before every `bun test` run (bunfig.toml, [test] preload): no test
// file may leave a global behind.
//
// The whole suite runs in one process and bun walks the files in directory
// order, which differs between this Mac and Linux (CI, the merge queue). A
// `document` stub, a read-only `location`, a fake `localStorage` that one file
// forgets to put back is then seen by a different set of files on each machine,
// and the suite fails on tests that were never touched. This guard snapshots
// every own property of globalThis (its descriptor: value, accessor, writable,
// configurable, enumerable) before the first file, compares at every file
// switch and after the last file, names the file that left each change, and
// fails the run at the end. unit/support/globals.ts has the helpers that stub
// and restore correctly.
//
// Attribution: bun gives no per-file hook, so the switch is seen in the first
// beforeEach of the next file. A change already present at the previous
// file's last afterEach is that file's doing. A change that appears between
// its last test and the next file's first (its afterAll, or the next file's
// import-time setup) is held one file: if it is still there at the following
// switch, neither file put it back and both are named.

import { afterAll, afterEach, beforeEach } from "bun:test";

type Desc = PropertyDescriptor | undefined;
type Snap = Map<string, Desc>;

/** Globals a library adds for itself when imported; not a test's stub. */
const LIBRARY_GLOBALS = new Set([
  "mongodbClient", // the Mongo driver's frozen rollback copy, unit/support/testMocks.ts
  "DOMMatrix", // pdf.js polyfills it on import
  "pdfjsLib",
  "pdfjsWorker",
  "_pdfjsTestingUtils",
]);
/** App singletons (`__lk…`), tslib and zod helpers (`__extends`, `__zod_…`): module state, not stubs. */
const isLibraryName = (name: string) => name.startsWith("__") || LIBRARY_GLOBALS.has(name);

function snapshot(): Snap {
  const m: Snap = new Map();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (isLibraryName(name)) continue;
    m.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  return m;
}

function sameDesc(a: Desc, b: Desc): boolean {
  if (!a || !b) return a === b;
  return (
    Object.is(a.value, b.value) &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.configurable === b.configurable &&
    a.enumerable === b.enumerable
  );
}

/** The names whose descriptor differs between two snapshots. */
function changed(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (!sameDesc(a.get(name), b.get(name))) out.push(name);
  }
  return out.sort();
}

function show(d: Desc): string {
  if (!d) return "absent";
  const flags = `${d.writable === false ? "read-only " : ""}${d.configurable === false ? "non-configurable " : ""}`;
  if (d.get || d.set) return `${flags}accessor`;
  const v = d.value;
  const kind =
    v === undefined
      ? "undefined"
      : v === null
        ? "null"
        : typeof v === "function"
          ? `function ${v.name || "(anonymous)"}`
          : typeof v === "object"
            ? `{${Object.keys(v as object)
                .slice(0, 4)
                .join(", ")}${Object.keys(v as object).length > 4 ? ", …" : ""}}`
            : JSON.stringify(v);
  return `${flags}${kind}`;
}

const rel = (p: string) => p.replace(/^.*\/unit\//, "unit/");

const baseline = snapshot();
let atLastTest: Snap = baseline; // after the current file's most recent test
let atStart: Snap = baseline; // at the current file's first test
let current = ""; // the file whose tests are running
let previous = "<start>";
/** Changes seen between a file's last test and the next file's first, waiting for the next switch. */
let held = new Map<string, Desc>();
/** Every leak reported, by name, with the descriptor it was reported with (so a persisting one is named once). */
const reported = new Map<string, Desc>();
const leaks: string[] = [];

function leak(line: string, name: string, desc: Desc) {
  reported.set(name, desc);
  leaks.push(line);
  console.error(`[globals-guard] ${line}`);
}

/** The file `current` is done (its afterAll ran); `next` is about to run its first test. */
function fileSwitch(next: string) {
  const now = snapshot();
  const dirty = new Set(changed(baseline, now));
  const nextHeld = new Map<string, Desc>();
  for (const name of dirty) {
    const d = now.get(name);
    const since = `globalThis.${name}: was ${show(baseline.get(name))}, now ${show(d)}`;
    if (reported.has(name) && sameDesc(reported.get(name), d)) continue; // the same leak, still there
    if (sameDesc(d, atLastTest.get(name))) {
      // Present when the file's last test ended.
      if (sameDesc(d, atStart.get(name)) && held.has(name) && sameDesc(held.get(name), d)) {
        leak(
          `${previous} (its afterAll) or ${rel(current)} (import-time setup, not put back by its afterAll) left ${since}`,
          name,
          d,
        );
      } else if (!sameDesc(d, atStart.get(name))) {
        leak(`${rel(current)} left ${since} (set by a test, never put back)`, name, d);
      } else {
        leak(`${rel(current)} left ${since}`, name, d);
      }
    } else {
      // Changed after its last test: its afterAll, or `next`'s import-time code. Decide at the next switch.
      nextHeld.set(name, d);
    }
  }
  for (const name of reported.keys()) if (!dirty.has(name)) reported.delete(name);
  held = nextHeld;
  previous = current ? rel(current) : "<start>";
  current = next;
  atStart = now;
  atLastTest = now;
}

beforeEach(() => {
  if (Bun.main !== current) fileSwitch(Bun.main);
});

afterEach(() => {
  atLastTest = snapshot();
});

afterAll(() => {
  fileSwitch("<end>");
  for (const [name, d] of held) {
    leak(
      `${previous} left globalThis.${name}: was ${show(baseline.get(name))}, now ${show(d)} (after its last test)`,
      name,
      d,
    );
  }
  if (leaks.length) {
    throw new Error(
      `${leaks.length} global${leaks.length === 1 ? "" : "s"} left behind by test files — the suite then depends on file order (unit/support/globals.ts has stubGlobals/restoreGlobal):\n  ${leaks.join("\n  ")}`,
    );
  }
});
