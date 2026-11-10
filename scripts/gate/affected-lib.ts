/**
 * Which unit tests and qa suites a change can affect (docs/shipping.md, "Only
 * what changed"). Pure: the file list and file contents come in as arguments,
 * so unit/affected-gate.test.ts drives it with an in-memory repo.
 *
 * The graph is static and deliberately over-inclusive. Every string literal in
 * a source file that names a repo file is an edge: `import … from "@/lib/x"`,
 * `await import("./y")`, `mock.module("@/z")`, `readFileSync("app/fsrs.ts")`,
 * `new URL("../worker.ts", import.meta.url)` — one rule covers them all, and a
 * literal in a comment that happens to name a file only adds a test, never
 * drops one. In unit/** files a literal naming a directory, or a glob, makes
 * the file depend on everything under it (tests that walk `app/api` or scan
 * `scripts/**`).
 */
import { Glob } from "bun";
import { posix } from "node:path";

export const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
export const TEST_FILE = /^unit\/.*\.test\.(?:ts|tsx|js|jsx|mjs)$/;
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".json"];

/**
 * A change to any of these runs the full unit suite with its coverage gate:
 * the toolchain, the test setup, this selector, and the core nearly every
 * suite reaches (D1, auth, the DB switch).
 */
export const UNIT_FULL = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "patches/**",
  "unit/support/**",
  "scripts/gate/**",
  ".husky/pre-push",
  "lib/d1/**",
  "auth.ts",
  "app/db.ts",
];

/**
 * …and these run the full qa:all: all of the above, plus what every suite's
 * Worker is built and served from, and qa:all's own machinery.
 */
export const QA_FULL = [
  ...UNIT_FULL,
  "next.config.*",
  "open-next.config.ts",
  "wrangler.jsonc",
  "worker.ts",
  "proxy.ts",
  "middleware.ts",
  "intlayer.config.ts",
  "playwright.config.ts",
  "db/migrations/**",
  "scripts/qa/qa-all.mjs",
  "scripts/qa/gate-suites.ts",
  "scripts/qa/suites.mjs",
  "scripts/qa/load-budget.mjs",
  "scripts/qa/silent.mjs",
  "scripts/dev/machine-lock-lib.ts",
];

export type Aliases = { exact: Map<string, string>; prefix: [string, string, string][] };

/** tsconfig.json's compilerOptions.paths → resolvers. `@/*` → `./*` etc. */
export function aliasesFrom(paths: Record<string, string[]>): Aliases {
  const exact = new Map<string, string>();
  const prefix: [string, string, string][] = [];
  for (const [k, [v]] of Object.entries(paths)) {
    const to = v.replace(/^\.\//, "");
    if (k.endsWith("*")) {
      const star = to.indexOf("*");
      prefix.push([k.slice(0, -1), to.slice(0, star), to.slice(star + 1)]);
    } else exact.set(k, to);
  }
  // Longest prefix first, so @lianki/core/* wins over @/*.
  prefix.sort((a, b) => b[0].length - a[0].length);
  return { exact, prefix };
}

/** JSON with comments and trailing commas (tsconfig.json), string-aware. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// A quoted run of path characters. No spaces, so prose in quotes ("don't …")
// never matches; template `${…}` is kept so its static prefix can be used.
const LITERAL = /(["'`])([\w@()[\]\-./${}*,+~]{1,300})\1/g;
const NAMED_FILE = /\.[a-z]{1,6}$/i;

// intlayer content is looked up by key, not imported: `useIntlayer("app-shell")`
// reads the `*.content.ts` that declares `key: "app-shell"`.
const INTLAYER_USE = /\b(?:use|get)Intlayer\(\s*["'`]([\w.-]+)["'`]/g;
const INTLAYER_KEY = /\bkey:\s*["'`]([\w.-]+)["'`]/g;
export const USES_KEY = "intlayer-use:";
export const DECLARES_KEY = "intlayer-key:";

// A data file that lists paths it does not load (scripts/qa/suites.mjs names
// every suite's entry) opts out of literal edges with this pragma: only its
// real import specifiers count.
export const IMPORTS_ONLY = "affected-gate: imports-only";
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\s]+)\1/g;

/** The string literals in a file that could name a repo path, plus intlayer keys. */
export function pathLiterals(src: string): string[] {
  const out = new Set<string>();
  const matches = src.includes(IMPORTS_ONLY) ? src.matchAll(IMPORT_SPEC) : src.matchAll(LITERAL);
  for (const m of matches) {
    const s = m[2];
    if (s.includes("/") || NAMED_FILE.test(s)) out.add(s);
  }
  for (const m of src.matchAll(INTLAYER_USE)) out.add(USES_KEY + m[1]);
  for (const m of src.matchAll(INTLAYER_KEY)) out.add(DECLARES_KEY + m[1]);
  return [...out];
}

export type FileDeps = { files: string[]; dirs: string[]; globs: string[] };

export type Repo = {
  files: Set<string>;
  dirs: Set<string>;
  aliases: Aliases;
  /** intlayer key → the *.content.ts files declaring it (filled by buildGraph). */
  contentKeys: Map<string, string[]>;
};

export function makeRepo(fileList: Iterable<string>, aliases: Aliases): Repo {
  const files = new Set(fileList);
  const dirs = new Set<string>();
  for (const f of files) {
    for (let d = posix.dirname(f); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  }
  return { files, dirs, aliases, contentKeys: new Map() };
}

function tryFile(repo: Repo, p: string): string | null {
  if (repo.files.has(p)) return p;
  for (const e of RESOLVE_EXTS) if (repo.files.has(p + e)) return p + e;
  for (const e of RESOLVE_EXTS) if (repo.files.has(`${p}/index${e}`)) return `${p}/index${e}`;
  // TypeScript ESM style: "./x.js" names x.ts.
  const m = /^(.*)\.(?:js|jsx|mjs)$/.exec(p);
  if (m) for (const e of [".ts", ".tsx", ".mts"]) if (repo.files.has(m[1] + e)) return m[1] + e;
  return null;
}

/** Candidate repo paths a literal could mean, from the file it is written in. */
function candidates(repo: Repo, from: string, spec: string): string[] {
  const s = spec.replace(/[?#].*$/, "");
  const out: string[] = [];
  const exact = repo.aliases.exact.get(s);
  if (exact) out.push(exact);
  for (const [k, pre, post] of repo.aliases.prefix) {
    if (s.startsWith(k)) {
      out.push(pre + s.slice(k.length) + post);
      break;
    }
  }
  if (s.startsWith("./") || s.startsWith("../")) out.push(posix.join(posix.dirname(from), s));
  else if (!out.length) {
    out.push(s); // root-relative: readFileSync("app/fsrs.ts")
    out.push(posix.join(posix.dirname(from), s)); // join(import.meta.dir, "x.page.tsx")
  }
  return out
    .map((p) => posix.normalize(p).replace(/\/$/, ""))
    .filter((p) => p !== "." && p !== "" && !p.startsWith("../") && !p.startsWith("/"));
}

/** What one file depends on, given its literals. Dirs and globs only for unit/**. */
export function resolveDeps(repo: Repo, from: string, literals: string[]): FileDeps {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const globs = new Set<string>();
  const wide = from.startsWith("unit/");
  for (const lit of literals) {
    if (lit.startsWith(USES_KEY)) {
      for (const f of repo.contentKeys.get(lit.slice(USES_KEY.length)) ?? []) files.add(f);
      continue;
    }
    if (lit.startsWith(DECLARES_KEY)) continue;
    const tpl = lit.indexOf("${");
    if (tpl >= 0) {
      if (!wide) continue;
      // `app/(app)/${x}/page.tsx` → everything under app/(app).
      const pre = lit.slice(0, tpl);
      const dir = pre.endsWith("/") ? pre : posix.dirname(pre);
      if (dir === "." || !dir) continue; // `${x}` alone names nothing
      for (const c of candidates(repo, from, dir)) if (repo.dirs.has(c)) dirs.add(c);
      continue;
    }
    if (/[*{]/.test(lit)) {
      // "**/*" names everything, so it is no one's dependency (a lint-staged key).
      if (wide && lit.replace(/[*/{}.,]/g, "")) globs.add(lit.replace(/^\.\//, ""));
      continue;
    }
    for (const c of candidates(repo, from, lit)) {
      const f = tryFile(repo, c);
      if (f && f !== from) files.add(f);
      else if (wide && repo.dirs.has(c)) dirs.add(c);
    }
  }
  return { files: [...files], dirs: [...dirs], globs: [...globs] };
}

export type Graph = Map<string, FileDeps>;

/** The whole graph from (path → literals) of every code file. */
export function buildGraph(repo: Repo, literals: Map<string, string[]>): Graph {
  repo.contentKeys.clear();
  for (const [f, lits] of literals) {
    if (!f.endsWith(".content.ts")) continue;
    for (const l of lits) {
      if (!l.startsWith(DECLARES_KEY)) continue;
      const k = l.slice(DECLARES_KEY.length);
      repo.contentKeys.set(k, [...(repo.contentKeys.get(k) ?? []), f]);
    }
  }
  const g: Graph = new Map();
  for (const [f, lits] of literals) g.set(f, resolveDeps(repo, f, lits));
  return g;
}

const globs = new Map<string, Glob>();
function glob(p: string): Glob {
  let g = globs.get(p);
  if (!g) globs.set(p, (g = new Glob(p)));
  return g;
}

export function matchesAny(path: string, patterns: string[]): string | null {
  for (const p of patterns) if (glob(p).match(path)) return p;
  return null;
}

/**
 * Every file that can see a change, each with the changed file that reached
 * it (for the "why" line). Seeds: the changed files, and each unit file whose
 * dir/glob covers a changed file.
 */
export function affectedBy(graph: Graph, changed: string[]): Map<string, string> {
  const rev = new Map<string, string[]>();
  for (const [f, d] of graph) {
    for (const t of d.files) {
      let r = rev.get(t);
      if (!r) rev.set(t, (r = []));
      r.push(f);
    }
  }
  const why = new Map<string, string>();
  const queue: string[] = [];
  const seed = (f: string, cause: string) => {
    if (why.has(f)) return;
    why.set(f, cause);
    queue.push(f);
  };
  for (const c of changed) seed(c, c);
  for (const [f, d] of graph) {
    if (!d.dirs.length && !d.globs.length) continue;
    for (const c of changed) {
      const hit =
        d.dirs.some((dir) => c.startsWith(`${dir}/`)) || d.globs.some((p) => glob(p).match(c));
      if (hit) {
        seed(f, c);
        break;
      }
    }
  }
  while (queue.length) {
    const f = queue.shift()!;
    for (const up of rev.get(f) ?? []) seed(up, why.get(f)!);
  }
  return why;
}

export type UnitPlan =
  | { mode: "full"; reason: string }
  | { mode: "some"; tests: [string, string][]; total: number };

export function planUnit(
  changed: string[],
  affected: Map<string, string> | null,
  allTests: string[],
): UnitPlan {
  for (const c of changed) {
    const p = matchesAny(c, UNIT_FULL);
    if (p) return { mode: "full", reason: `${c} changed (matches ${p})` };
  }
  if (!affected) return { mode: "full", reason: "the import graph could not be built" };
  const tests = allTests
    .filter((t) => affected.has(t))
    .sort()
    .map((t) => [t, affected.get(t)!] as [string, string]);
  return { mode: "some", tests, total: allTests.length };
}

export type QaSuite = { id: string; name: string; args: string[]; paths?: string[] };

export type QaPlan =
  | { mode: "full"; reason: string }
  | { mode: "some"; suites: [string, string][]; total: number };

/**
 * A suite runs when its own entry file (or anything it imports) changed, or
 * when a file the change reaches matches one of its `paths`.
 */
export function planQa(
  changed: string[],
  affected: Map<string, string> | null,
  suites: QaSuite[],
): QaPlan {
  for (const c of changed) {
    const p = matchesAny(c, QA_FULL);
    if (p) return { mode: "full", reason: `${c} changed (matches ${p})` };
  }
  if (!affected) return { mode: "full", reason: "the import graph could not be built" };
  const reached = [...affected.keys()].filter((f) => !f.startsWith("unit/"));
  const out: [string, string][] = [];
  for (const s of suites) {
    const entry = s.args.find((a) => a.includes("/"));
    if (entry && affected.has(entry)) {
      out.push([s.id, `${entry} ← ${affected.get(entry)}`]);
      continue;
    }
    const pats = s.paths ?? [];
    for (const f of reached) {
      const p = matchesAny(f, pats);
      if (p) {
        const cause = affected.get(f)!;
        out.push([s.id, cause === f ? `${f} (${p})` : `${f} (${p}) ← ${cause}`]);
        break;
      }
    }
  }
  return { mode: "some", suites: out, total: suites.length };
}

/**
 * The merge queue's always-on smoke set (owner, 2026-11-10): the API, the main
 * UI with sign-in, and Sign out run on every queued PR, whatever it touches.
 */
export const QA_SMOKE = ["api", "ui", "sign-out"];

/**
 * What the merge queue runs: null for the full set (a core path changed, or
 * the graph could not be built), else the affected suites plus QA_SMOKE, in
 * suites.mjs order.
 */
export function ciQaSuites(plan: QaPlan, suites: { id: string }[]): string[] | null {
  if (plan.mode === "full") return null;
  const want = new Set([...QA_SMOKE, ...plan.suites.map(([id]) => id)]);
  return suites.filter((s) => want.has(s.id)).map((s) => s.id);
}
