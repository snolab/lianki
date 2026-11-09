/**
 * The build that served this page, read from <html data-build> (set by the
 * root layout, app/layout.tsx) rather than inlined into client code.
 *
 * Why not process.env.NEXT_PUBLIC_BUILD_ID in the client: an inlined id
 * differs on every build, and the minifier's name choices follow the
 * characters it contains, so the chunk carrying it came out different on
 * every deploy even when no code changed. Smart refresh hashes client chunks
 * per route (lib/smart-refresh.ts); with the id in the HTML instead, a deploy
 * that changes no client code leaves every chunk byte-identical.
 */
export const BUILD_ATTR = "data-build";

export function pageBuildId(doc: Document | undefined = globalThis.document): string {
  return doc?.documentElement.getAttribute(BUILD_ATTR) || "dev";
}
