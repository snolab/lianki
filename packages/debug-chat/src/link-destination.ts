/** The location is supplied, so rendering and tests do not depend on globals. */
export type LinkLocation = { origin: string; href?: string };
const PROD = "https://lianki.com";
const PREVIEW = "https://preview.lianki.com";
const production = (url: URL) => url.origin === PROD || url.origin === "https://www.lianki.com";
const explicitProd = (url: URL) =>
  url.searchParams.getAll("site").includes("prod") || url.hash === "#prod";

/** Preview defaults an apex link to this origin; explicit production links stay verbatim. */
export function sameOriginHref(href: string, location: LinkLocation): string {
  if (location.origin !== PREVIEW) return href;
  try {
    const url = new URL(href, location.href ?? location.origin);
    if (!production(url) || explicitProd(url)) return href;
    return `${location.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

/** Only preview's Lianki links offer a second, production destination. */
export function linkDestinations(href: string, location: LinkLocation) {
  let prod: string | null = null;
  let forceProd = false;
  try {
    const url = new URL(href, location.href ?? location.origin);
    if (location.origin === PREVIEW && (production(url) || url.origin === PREVIEW)) {
      prod = production(url) ? href : `${PROD}${url.pathname}${url.search}${url.hash}`;
      forceProd = explicitProd(url);
    }
  } catch {}
  return { href: forceProd && prod ? prod : sameOriginHref(href, location), prod, forceProd };
}
