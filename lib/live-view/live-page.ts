/**
 * Is this page the owner's same-origin live preview (lib/live-view/page-proxy.ts,
 * docs/live-view.md "Same-origin pages")? Its address carries `?live=<serial>`
 * (the badge's script keeps it there on in-app navigation) and the badge's
 * script sets `window.__lkLive`. Such a page is a dev build, whose build id
 * never matches production's, so the "New version" notice stays away from it.
 * Tiny on purpose: it ships in the app bundle.
 */
export const LIVE_PAGE_GLOBAL = "__lkLive";

export function onLivePage(
  search: string = typeof location === "undefined" ? "" : location.search,
  w: Record<string, unknown> = typeof window === "undefined"
    ? {}
    : (window as unknown as Record<string, unknown>),
): boolean {
  return /(^\?|&)live=\d+(&|$)/.test(search) || typeof w[LIVE_PAGE_GLOBAL] === "string";
}
