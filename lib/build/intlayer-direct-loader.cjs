/**
 * A Turbopack loader for the browser bundle: `useIntlayer("key", …)` from
 * next-intlayer becomes `useDictionary(<that dictionary's JSON>, …)`, imported
 * directly, so each page ships only the dictionaries its client components use.
 *
 * Why: useIntlayer looks the key up in @intlayer/dictionaries-entry, which
 * imports every dictionary, so every page carried all of them in all 16
 * locales — 2.3 MB of JS (0.7 MB gzipped) to download, parse and run before a
 * phone's cold start could hydrate. useIntlayer(k, l) is exactly
 * useDictionary(dictionaries[k], l) (react-intlayer: both are
 * getDictionary(dict, l ?? context locale) in a useMemo), so the page renders
 * the same. intlayer's own optimizer (@intlayer/swc) does this too, but its
 * Wasm plugin does not run on Next 16.4's SWC.
 *
 * Only string-literal keys are rewritten; a file with any other useIntlayer
 * call keeps the lookup (and with it the whole entry). The server bundle is
 * left alone. Registered in next.config.mjs (turbopack.rules, browser only);
 * unit/intlayer-direct-loader.test.ts holds the rewrite.
 */
const path = require("node:path");

const CALL = /\buseIntlayer\(\s*(["'])([\w.-]+)\1/g;
const IMPORTED = /import\s*\{[^}]*\buseIntlayer\b[^}]*\}\s*from\s*["']next-intlayer["']/;
const HOOK = "__lkUseDictionary";

/**
 * @param {string} source
 * @param {string} resourcePath the file being compiled
 * @param {string} root the project root (where .intlayer/ lives)
 * @returns {string}
 */
function rewrite(source, resourcePath, root) {
  if (!IMPORTED.test(source)) return source;
  // Any call this cannot rewrite (a variable key): leave the file as it was.
  const all = source.match(/\buseIntlayer\(/g)?.length ?? 0;
  const literal = source.match(CALL)?.length ?? 0;
  if (all === 0 || all !== literal) return source;
  const dir = path.dirname(resourcePath);
  /** @type {Map<string, string>} */
  const ids = new Map();
  const out = source
    .replace(CALL, (_m, _q, key) => {
      if (!ids.has(key)) ids.set(key, `__lkDict${ids.size}`);
      return `${HOOK}(${ids.get(key)}`;
    })
    // Drop the now-unused useIntlayer binding (an emptied import goes entirely).
    .replace(IMPORTED, (decl) => {
      const rest = decl
        .replace(/^import\s*\{|\}\s*from[\s\S]*$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "useIntlayer");
      return rest.length ? `import { ${rest.join(", ")} } from "next-intlayer"` : "";
    });
  const imports = [`import { useDictionary as ${HOOK} } from "next-intlayer";`];
  for (const [key, id] of ids) {
    let rel = path.relative(dir, path.join(root, ".intlayer", "dictionary", `${key}.json`));
    rel = rel.split(path.sep).join("/");
    if (!rel.startsWith("../")) rel = `./${rel}`;
    imports.push(`import ${id} from ${JSON.stringify(rel)};`);
  }
  // Imports are hoisted, so appending them keeps a leading "use client" first.
  return `${out}\n${imports.join("\n")}\n`;
}

module.exports = function intlayerDirect(source) {
  return rewrite(source, this.resourcePath, this.rootContext || process.cwd());
};
module.exports.rewrite = rewrite;
