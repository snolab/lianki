/** The pure half of scripts/ci/check-worker-exports.ts (unit-tested). */

/** What worker.ts adds to the build's exports. */
export const ADDED = ["DebugSessions"];

/**
 * The names an ES module's source exports (`export {a, b as c}`, `export
 * default`, declarations) — top-level statements only, at the start of a
 * line: a bundle carries indented `export function middleware` text inside
 * embedded sources, which is not an export of the bundle.
 */
export function exportNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  if (/^export\s+default\b/m.test(src)) names.add("default");
  for (const m of src.matchAll(
    /^export\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(m[1]);
  return names;
}

/** What is missing from the bundle, and what it has that it should not. */
export function compareExports(artifact: Set<string>, bundle: Set<string>, added = ADDED) {
  const want = new Set([...artifact, ...added]);
  return {
    missing: [...want].filter((n) => !bundle.has(n)).sort(),
    extra: [...bundle].filter((n) => !want.has(n)).sort(),
  };
}
