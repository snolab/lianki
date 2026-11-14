/** Only Lianki app references become executable cards; arbitrary external links remain links. */
export type MiniAppRef = { type: "app"; slug: string };
const reserved = new Set(["sdk", "sdk-js", "presets", "new", "api", "edit", "settings"]);
export const isMiniAppSlug = (slug: unknown): slug is string =>
  typeof slug === "string" &&
  slug.length <= 40 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
  !reserved.has(slug);

export function cleanAppRefs(raw: unknown): MiniAppRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = new Map<string, MiniAppRef>();
  for (const value of raw) {
    if (value && typeof value === "object" && value.type === "app" && isMiniAppSlug(value.slug)) {
      refs.set(value.slug, { type: "app", slug: value.slug });
      if (refs.size === 4) break;
    }
  }
  return refs.size ? [...refs.values()] : undefined;
}

const publicOrigins = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
  "https://dev.lianki.com",
]);
function localOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      !url.username &&
      !url.password &&
      url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function miniAppApiOrigin(origin?: string): string {
  return origin && (publicOrigins.has(origin) || localOrigin(origin))
    ? origin
    : "https://lianki.com";
}

export function miniAppSlug(href: string, origin?: string): string | null {
  // Do not normalize encoded paths, backslashes, credentials, or external lookalike hosts.
  if (
    /[\\\s]/.test(href) ||
    href.startsWith("//") ||
    (!href.startsWith("/m/") && !/^https?:\/\//.test(href))
  )
    return null;
  try {
    const url = new URL(href, "https://lianki.com");
    const own = publicOrigins.has(url.origin) || (origin === url.origin && localOrigin(origin));
    if (!own || url.username || url.password) return null;
    const path = /^\/m\/([^/]+)\/?$/.exec(url.pathname);
    return path && isMiniAppSlug(path[1]) ? path[1] : null;
  } catch {
    return null;
  }
}

export function miniAppsIn(
  text: string,
  apps?: readonly MiniAppRef[],
  origin?: string,
): MiniAppRef[] {
  const refs: unknown[] = [...(apps ?? [])];
  const urls = text.matchAll(/https?:\/\/[^\s<>"']+|(?<![\w/:])\/m\/[^\s<>"']+/g);
  for (const match of urls) {
    const slug = miniAppSlug(match[0].replace(/[)\],.!?;:]+$/, ""), origin);
    if (slug) refs.push({ type: "app", slug });
  }
  return cleanAppRefs(refs) ?? [];
}
