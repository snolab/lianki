/**
 * Builds the hot-island module (docs/dev-hot-islands.md): lib/islands/entry.ts
 * (or --entry) bundled as one ESM file, with every shared module
 * (SHARED_MODULES) read from the page's globalThis.__lkModules instead of
 * bundled, the Tailwind utilities its sources use, and a fingerprint per
 * island so the server can say which islands a save touched. No server here.
 */
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { MODULES_GLOBAL, SHARED_MODULES } from "../../lib/islands/rules";
import { ROOT, widgetCss } from "./debug-widget-build";

export const ISLANDS_ENTRY = resolve(ROOT, "lib/islands/entry.ts");
const NS = "lk-host";
const IDENT = /^[A-Za-z_$][\w$]*$/;
const SHARED = new Set<string>(SHARED_MODULES);
/** The JSX dev runtime is the page's JSX runtime too. */
const ALIASES: Record<string, string> = { "react/jsx-dev-runtime": "react/jsx-runtime" };

/**
 * The stand-in for one shared module: it re-exports the page's instance from
 * globalThis.__lkModules[spec]. `keys` are the real module's named exports.
 */
export function hostStub(spec: string, keys: string[]): string {
  const target = ALIASES[spec] ?? spec;
  const g = `globalThis[${JSON.stringify(MODULES_GLOBAL)}]`;
  const names = [...new Set(keys)].filter((k) => IDENT.test(k) && k !== "default");
  const dev =
    spec === "react/jsx-dev-runtime"
      ? `export const jsxDEV = (type, props, key) => M.jsx(type, props, key);\n`
      : "";
  return (
    `const M = ${g} && ${g}[${JSON.stringify(target)}];\n` +
    `if (!M) throw new Error("the page did not share ${target} (${MODULES_GLOBAL})");\n` +
    `export default ("default" in M ? M.default : M);\n` +
    (names.length ? `export const { ${names.join(", ")} } = M;\n` : "") +
    dev
  );
}

/** A shared module's named exports: scanned from TS source, else read by importing it. */
export async function exportNames(spec: string): Promise<string[]> {
  const target = ALIASES[spec] ?? spec;
  const file = Bun.resolveSync(target, ROOT);
  const ext = extname(file);
  if (ext === ".ts" || ext === ".tsx")
    return new Bun.Transpiler({ loader: ext === ".tsx" ? "tsx" : "ts" }).scan(
      readFileSync(file, "utf8"),
    ).exports;
  // An ES module is scanned too: importing one may touch the DOM (next-intlayer
  // reads `document` when it loads). Only CommonJS (react) or `export *` is imported.
  if (ext === ".mjs" || ext === ".js") {
    const src = readFileSync(file, "utf8");
    const { exports } = new Bun.Transpiler({ loader: "js" }).scan(src);
    if (exports.length && !/export\s*\*/.test(src)) return exports;
  }
  const keys = Object.keys((await import(file)) as Record<string, unknown>);
  return target === "react/jsx-runtime" ? [...keys, "jsx", "jsxs", "Fragment"] : keys;
}

/** Files of the shared app modules (e.g. lib/dates.ts), so a relative import of one is shared too. */
function sharedFiles(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of SHARED_MODULES) if (s.startsWith("@/")) m.set(Bun.resolveSync(s, ROOT), s);
  return m;
}

/**
 * Rewrites every shared import to hostStub(). Any other `react*` subpath
 * (e.g. react-dom/client) fails the build: bundling it would start a second
 * React.
 */
export function shareHostModules(): BunPlugin {
  const files = sharedFiles();
  return {
    name: "share-host-modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (SHARED.has(spec) || spec in ALIASES) return { path: spec, namespace: NS };
        if (/^react(-dom)?(\/|$)/.test(spec)) return { path: spec, namespace: "lk-refused" };
        if (spec.startsWith(".") && args.importer) {
          try {
            const shared = files.get(Bun.resolveSync(spec, dirname(args.importer)));
            if (shared) return { path: shared, namespace: NS };
          } catch {}
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: NS }, async (args) => ({
        contents: hostStub(args.path, await exportNames(args.path)),
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "lk-refused" }, (args) => {
        throw new Error(
          `${args.path} is not shared with the page (lib/islands/rules.ts SHARED_MODULES); bundling it would load a second copy`,
        );
      });
    },
  };
}

/**
 * Which component each island is, from the entry's source: one
 * `import { X } from "spec"` per island and `"name": X` in `islands = {…}`.
 * Returns island name → the resolved file it comes from (the entry itself for
 * an island defined there).
 */
export function islandSources(entry: string, src = readFileSync(entry, "utf8")) {
  const from = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g))
    for (const part of m[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local && !local.startsWith("type ")) from.set(local, m[2]);
    }
  const block = src.match(/export const islands\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/["']([\w.-]+)["']\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    const spec = from.get(m[2]);
    // Defined in the entry itself.
    if (!spec) {
      out[m[1]] = entry;
      continue;
    }
    try {
      out[m[1]] = Bun.resolveSync(spec, dirname(entry));
    } catch {}
  }
  return out;
}

/** Each island's fingerprint: a hash over the files it reaches in the bundle's import graph. */
export function islandFingerprints(
  sources: Record<string, string>,
  graph: Map<string, string[]>,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(sources)) {
    const seen = new Set<string>();
    const stack = [file];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...(graph.get(f) ?? []));
    }
    let text = "";
    for (const f of [...seen].sort()) {
      try {
        text += `\0${f}\0${read(f)}`;
      } catch {}
    }
    out[name] = Bun.hash(text).toString(36);
  }
  return out;
}

/** The names whose fingerprint changed (all of them when the entry itself did). */
export function changedIslands(
  prev: Record<string, string>,
  next: Record<string, string>,
  entryChanged: boolean,
): string[] {
  const names = Object.keys(next);
  return entryChanged ? names : names.filter((n) => prev[n] !== next[n]);
}

export type IslandsBuild = {
  code: string;
  rev: string;
  inputs: string[];
  fingerprints: Record<string, string>;
  entryHash: string;
};

/** Bundle the islands entry to one ESM file, with its CSS, rev and per-island fingerprints. */
export async function buildIslands(entry = ISLANDS_ENTRY): Promise<IslandsBuild> {
  const out = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [shareHostModules()],
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  const js = await out.outputs[0].text();
  const abs = (p: string) => resolve(process.cwd(), p);
  const graph = new Map<string, string[]>();
  const inputs: string[] = [];
  for (const [p, info] of Object.entries(out.metafile?.inputs ?? {})) {
    if (p.includes(":")) continue; // a plugin namespace (the page's modules)
    inputs.push(abs(p));
    graph.set(
      abs(p),
      info.imports.filter((i) => !i.path.includes(":")).map((i) => abs(i.path)),
    );
  }
  const css = await widgetCss(
    inputs.filter((p) => /\.tsx?$/.test(p) && !p.includes("/node_modules/")),
  );
  const rev = Bun.hash(js + css)
    .toString(36)
    .slice(0, 8);
  const code = `${js}\nexport const css = ${JSON.stringify(css)};\nexport const rev = ${JSON.stringify(rev)};\n`;
  const entrySrc = readFileSync(entry, "utf8");
  return {
    code,
    rev,
    inputs,
    fingerprints: islandFingerprints(islandSources(entry, entrySrc), graph),
    entryHash: Bun.hash(entrySrc).toString(36),
  };
}

/** Files a typecheck reported errors in (tsgo's `path(line,col): error` lines), absolute. */
export function typeErrorFiles(output: string, cwd = ROOT): string[] {
  const files = new Set<string>();
  for (const m of output.matchAll(/^(.+?)\(\d+,\d+\): error /gm)) files.add(resolve(cwd, m[1]));
  return [...files];
}
