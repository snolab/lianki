/**
 * Is this page the owner's same-origin live preview (lib/live-view/page-proxy.ts,
 * docs/live-view.md "Same-origin pages")? Its address carries `?live=<serial>`
 * (the badge's script keeps it there on in-app navigation) and the badge's
 * script sets `window.__lkLive`. Such a page is a dev build, whose build id
 * never matches production's, so the "New version" notice stays away from it.
 * Tiny on purpose: it ships in the app bundle.
 */
export const LIVE_PAGE_GLOBAL = "__lkLive";

type Bag = Record<string, unknown>;
const here = (): { search: string; w: Bag } => ({
  search: globalThis.location?.search ?? "",
  w: globalThis as unknown as Bag,
});

export function onLivePage(search = here().search, w: Bag = here().w): boolean {
  return /(^\?|&)live=\d+(&|$)/.test(search) || typeof w[LIVE_PAGE_GLOBAL] === "string";
}
