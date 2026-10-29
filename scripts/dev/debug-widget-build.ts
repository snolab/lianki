/**
 * Builds the hot-loadable debug chat widget (docs/dev-debug-widget.md): the
 * ESM module scripts/dev/debug-widget-server.ts serves as /debug-chat.js, and
 * the small host page it serves as /harness for local tests. No server here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { compile } from "tailwindcss";
import { REACT_GLOBAL } from "../../lib/debug-widget";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const WIDGET_ENTRY = resolve(ROOT, "app/components/debug-chat-widget.ts");
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
  const list = names(keys);
  return (
    `${guard}const R = ${g}.${obj};\nexport default R;\n` +
    (list.length ? `export const { ${list.join(", ")} } = R;\n` : "")
  );
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

/** Class-name candidates in source text, for Tailwind (it drops what is not a utility). */
export function candidates(src: string): string[] {
  return [...new Set(src.split(/[\s"'`{}<>;,]+/).filter((t) => t && t.length < 200))];
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

/** Whom /debug-chat.js and /events answer cross-origin: lianki.com, or a local page. */
export function allowOrigin(origin: string | null): string {
  if (!origin) return "https://lianki.com";
  try {
    const u = new URL(origin);
    if (u.origin === "https://lianki.com") return origin;
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return origin;
  } catch {}
  return "https://lianki.com";
}

/** One Server-Sent Event. */
export const sse = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
