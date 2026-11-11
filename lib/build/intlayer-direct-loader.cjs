/**
 * A Turbopack loader: every dictionary lookup by key becomes a direct import of
 * that one dictionary, so code carries only the dictionaries it uses.
 *
 * - `useIntlayer("key", …)` from next-intlayer → `useDictionary(<JSON>, …)`
 * - `useIntlayer("key", …)` from next-intlayer/server → its `useDictionary`
 * - `getIntlayer("key", …)` from intlayer → `getDictionary(<JSON>, …)`
 *
 * Why: each of those looks the key up in @intlayer/dictionaries-entry, which
 * imports every dictionary in all 16 locales. In the browser that was 2.3 MB of
 * JS on every page; on the server, three copies of it (~16 MB of the Worker)
 * that a cold isolate loaded for every page it rendered (docs/cold-start.md).
 * Each pair is the same call underneath (react-intlayer and @intlayer/core:
 * the lookup is `getDictionary(dictionaries[key], locale ?? context locale)`),
 * so pages render the same. intlayer's own optimizer (@intlayer/swc) does
 * this too, but its Wasm plugin does not run on Next 16.4's SWC.
 *
 * Only string-literal keys are rewritten. With every lookup rewritten the
 * entry itself is an empty stub (lib/stubs/intlayer-no-dictionaries.mjs,
 * next.config.mjs); unit/intlayer-direct-loader.test.ts fails on any file it
 * would leave with a lookup (a variable key). Registered in next.config.mjs
 * (turbopack.rules).
 */
const path = require("node:path");

/** The lookups rewritten: the function, the module it comes from, and its direct twin. */
const APIS = [
  { fn: "useIntlayer", from: "next-intlayer", to: "useDictionary" },
  { fn: "useIntlayer", from: "next-intlayer/server", to: "useDictionary" },
  { fn: "getIntlayer", from: "intlayer", to: "getDictionary" },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const importOf = (api) =>
  new RegExp(`import\\s*\\{[^}]*\\b${api.fn}\\b[^}]*\\}\\s*from\\s*["']${esc(api.from)}["']`);

/**
 * The lookups a file makes that cannot be rewritten (a non-literal key), per
 * imported API; empty when every lookup can be.
 * @param {string} source
 * @returns {string[]}
 */
function leftovers(source) {
  const out = [];
  for (const api of APIS) {
    if (!importOf(api).test(source)) continue;
    const all = source.match(new RegExp(`\\b${api.fn}\\(`, "g"))?.length ?? 0;
    const literal = source.match(callOf(api.fn))?.length ?? 0;
    if (all !== literal) out.push(`${api.fn} from ${api.from}`);
  }
  return out;
}

const callOf = (fn) => new RegExp(`\\b${fn}\\(\\s*(["'])([\\w.-]+)\\1`, "g");

/**
 * @param {string} source
 * @param {string} resourcePath the file being compiled
 * @param {string} root the project root (where .intlayer/ lives)
 * @returns {string}
 */
function rewrite(source, resourcePath, root) {
  const used = APIS.filter((api) => importOf(api).test(source));
  if (!used.length || leftovers(source).length) return source;
  // A file that imports the same function name from two of these modules is not ours to guess.
  if (new Set(used.map((a) => a.fn)).size !== used.length) return source;
  const dir = path.dirname(resourcePath);
  /** @type {Map<string, string>} */
  const ids = new Map();
  const imports = [];
  let out = source;
  for (const api of used) {
    const hook = `__lk_${api.to}`;
    out = out
      .replace(callOf(api.fn), (_m, _q, key) => {
        if (!ids.has(key)) ids.set(key, `__lkDict${ids.size}`);
        return `${hook}(${ids.get(key)}`;
      })
      // Drop the now-unused binding (an emptied import goes entirely).
      .replace(importOf(api), (decl) => {
        const rest = decl
          .replace(/^import\s*\{|\}\s*from[\s\S]*$/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s !== api.fn);
        return rest.length ? `import { ${rest.join(", ")} } from "${api.from}"` : "";
      });
    imports.push(`import { ${api.to} as ${hook} } from "${api.from}";`);
  }
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
module.exports.leftovers = leftovers;
