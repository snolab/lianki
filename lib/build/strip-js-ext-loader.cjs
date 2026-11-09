/**
 * A Turbopack loader for the vendored rgui sources (packages/rgui/src,
 * docs/rgui.md). Upstream writes its relative imports the TypeScript-ESM way,
 * `import { x } from "./rule.js"` for rule.ts; Turbopack resolves them
 * literally and fails ("Can't resolve './rule.js'"), while bun and tsc map
 * .js to .ts. This drops the `.js` from relative specifiers so the bundler
 * finds the .ts file; upstream's files stay untouched (subtree pulls merge).
 * Registered in next.config.mjs (turbopack.rules), for packages/rgui/src only.
 */
module.exports = function stripJsExt(source) {
  return source.replace(
    /(\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s+["'])(\.{1,2}\/[^"']+?)\.js(["'])/g,
    "$1$2$3",
  );
};
