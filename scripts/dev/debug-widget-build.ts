/**
 * Builds the hot-loadable debug chat widget (docs/dev-debug-widget.md): the
 * ESM module scripts/dev/debug-widget-server.ts serves as /debug-chat.js, and
 * the small host page it serves as /harness for local tests. No server here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { compile } from "tailwindcss";
import { REACT_GLOBAL } from "../../packages/debug-chat/src/debug-widget";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const WIDGET_ENTRY = resolve(ROOT, "packages/debug-chat/src/debug-chat-widget.ts");
export const HARNESS_ENTRY = resolve(ROOT, "scripts/dev/debug-widget-harness.tsx");

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * The stand-in for one `react*` import: it reads the page's own React from
 * globalThis[REACT_GLOBAL], so the widget never carries a second copy.
 * `keys` are the named exports to re-export (the real module's).
 */
export function hostModule(spec: string, keys: string[]): string {
  const g = `globalThis[${JSON.stringify(REACT_GLOBAL)}]`;
  const names = (from: string[]) => from.filter((k) => IDENT.test(k) && k !== "default");
  const guard = `if (!${g}) throw new Error("the page did not share its React (${REACT_GLOBAL})");\n`;
  if (spec === "react/jsx-runtime" || spec === "react/jsx-dev-runtime")
    return (
      `${guard}const J = ${g}.jsx;\n` +
      `export const jsx = J.jsx, jsxs = J.jsxs, Fragment = J.Fragment;\n` +
      `export const jsxDEV = (type, props, key) => J.jsx(type, props, key);\n`
    );
  const obj = spec.startsWith("react-dom") ? "ReactDOM" : "React";
  // A dependency that default-imports React from node_modules (zustand's
  // `import React from "react"`) makes Bun wrap this module as CommonJS, and
  // the wrapped ESM exports came out empty ("useState is not a function").
  // So it is CommonJS to begin with: every importer, default or named, reads
  // the page's object through Bun's interop. `keys` only document the shape.
  void names(keys);
  return `${guard}module.exports = ${g}.${obj};\n`;
}

/** Rewrites every `react`, `react-dom` and JSX-runtime import to hostModule(). */
export function reactFromPage(): BunPlugin {
  return {
    name: "react-from-page",
    setup(build) {
      build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: "react-from-page",
      }));
      build.onLoad({ filter: /.*/, namespace: "react-from-page" }, async (args) => {
        const real = args.path.includes("jsx")
          ? {}
          : ((await import(args.path)) as Record<string, unknown>);
        return { contents: hostModule(args.path, Object.keys(real)), loader: "js" };
      });
    },
  };
}

/** Class-name candidates in source text, for Tailwind (it drops what is not a utility). Commas stay: w-[min(20rem,calc(100vw-1rem))]. */
export function candidates(src: string): string[] {
  return [...new Set(src.split(/[\s"'`{}<>;]+/).filter((t) => t && t.length < 200))];
}

/** The first top-level `@theme { … }` block of a stylesheet (the app's palette). */
export function themeBlock(css: string): string {
  const at = css.indexOf("@theme");
  if (at === -1) return "";
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  return "";
}

/**
 * The Tailwind utilities `files` use, with the app's theme, in the page's own
 * `utilities` layer — so classes the production CSS has never seen still work.
 */
export async function widgetCss(files: string[]): Promise<string> {
  const tw = dirname(Bun.resolveSync("tailwindcss/package.json", ROOT));
  const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
  const input = [
    "@layer theme, base, components, utilities;",
    '@import "tailwindcss/theme.css" layer(theme);',
    themeBlock(globals),
    "@theme { --color-background: var(--background); --color-foreground: var(--foreground); }",
    '@import "tailwindcss/utilities.css" layer(utilities);',
  ].join("\n");
  const c = await compile(input, {
    base: ROOT,
    loadStylesheet: async (id: string) => {
      const path = resolve(tw, id.replace(/^tailwindcss\//, ""));
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const seen = files.flatMap((f) => candidates(readFileSync(f, "utf8")));
  return c.build(seen);
}

export type WidgetBuild = { code: string; css: string; rev: string; inputs: string[] };

/** Bundle the widget entry to one ESM file, with its CSS and a content hash appended. */
export async function buildWidget(entry = WIDGET_ENTRY): Promise<WidgetBuild> {
  const out = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [reactFromPage()],
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  const js = await out.outputs[0].text();
  const inputs = Object.keys(out.metafile?.inputs ?? {})
    .filter((p) => !p.startsWith("react-from-page:"))
    .map((p) => resolve(process.cwd(), p));
  const css = await widgetCss(inputs.filter((p) => /\.tsx?$/.test(p)));
  const rev = Bun.hash(js + css)
    .toString(36)
    .slice(0, 8);
  const code = `${js}\nexport const css = ${JSON.stringify(css)};\nexport const rev = ${JSON.stringify(rev)};\n`;
  return { code, css, rev, inputs };
}

/** The host page for local tests: React bundled normally, the real DebugChatHost. */
export async function buildHarness(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [HARNESS_ENTRY],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0].text();
}

/**
 * Extra page origins the dev servers answer, from LIANKI_DEV_ORIGINS (comma-separated,
 * exact origins such as the whole-page dev server's tailnet origin, docs/dev-whole-page.md).
 * Exact matches only: never a wildcard.
 */
export function devOrigins(raw: string | undefined = process.env.LIANKI_DEV_ORIGINS): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === "https:") out.push(u.origin);
    } catch {}
  }
  return out;
}

/**
 * Whom /debug-chat.js, /events and /state-tree.md answer cross-origin: lianki.com, a local
 * page, or one of LIANKI_DEV_ORIGINS.
 */
export function allowOrigin(origin: string | null, extra: string[] = devOrigins()): string {
  if (!origin) return "https://lianki.com";
  try {
    const u = new URL(origin);
    if (u.origin === "https://lianki.com") return origin;
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return origin;
    if (extra.includes(u.origin)) return u.origin;
  } catch {}
  return "https://lianki.com";
}

/** One Server-Sent Event. */
export const sse = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;

/** Top-level blocks of a stylesheet, as [prelude, whole block] (comments dropped). */
export function topBlocks(css: string): [string, string][] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: [string, string][] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      const block = src.slice(start, i + 1).trim();
      out.push([block.slice(0, block.indexOf("{")).trim(), block]);
      start = i + 1;
    } else if (src[i] === ";" && depth === 0) start = i + 1;
  }
  return out;
}

/**
 * The app's own CSS the widget leans on, for /harness (on lianki.com the page
 * already has it): the page colours (light and dark), the halo, the 40px tap
 * area and the send bar. Utilities come with the widget module.
 */
export function harnessCss(): string {
  const globals = readFileSync(resolve(ROOT, "app/globals.css"), "utf8");
  const want = (prelude: string, block: string) =>
    /^\.(lk-halo|tap-40|lk-drain)\b/.test(prelude) ||
    prelude === "@keyframes lk-drain" ||
    ((prelude === ":root" || prelude.startsWith("@media (prefers-color-scheme")) &&
      block.includes("--background:") &&
      !block.includes("--glass"));
  const kept = topBlocks(globals)
    .filter(([p, b]) => want(p, b))
    .map(([, b]) => b);
  // A slice of Tailwind's preflight, in its layer (below the widget's utilities).
  const base =
    "@layer theme, base, components, utilities;\n@layer base{*,::before,::after{box-sizing:border-box;border:0 solid;margin:0;padding:0}" +
    "button,textarea{font:inherit;color:inherit;background:transparent}ol,ul{list-style:none}[hidden]{display:none!important}" +
    "body{background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif;line-height:1.5}}";
  return `${base}\n${kept.join("\n")}`;
}
