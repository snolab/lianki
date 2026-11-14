/**
 * The dev site's own PWA (lib/dev-site/pwa.ts): on the whole-page dev server
 * only, /manifest.json and /sw.js are answered by its route instead of the
 * public files (beforeFiles: ahead of public/). Production gets no rewrite.
 */
export function devSiteRewrites(env) {
  if (env.NODE_ENV !== "development" || env.LIANKI_DEV_WHOLE_PAGE !== "1") return [];
  return [
    { source: "/manifest.json", destination: "/api/dev-whole-page/pwa/manifest.json" },
    { source: "/sw.js", destination: "/api/dev-whole-page/pwa/sw.js" },
  ];
}
