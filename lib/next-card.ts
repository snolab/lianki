/**
 * Which card to review next, out of a deck the page can see for itself.
 *
 * The rule matches the server's `NEXT_DUE_SORT` (`{"card.due": -1}` over cards
 * that are already due): among everything due, take the one that came due most
 * recently. Not the oldest — that buries you in a backlog you will never see the
 * end of, and the most recently due card is the one you last decided was worth
 * remembering.
 *
 * On top of that, cards on the origin you are already on come first. Reviewing
 * is a chain of page loads, and a same-origin hop is a cheap one: warm caches, a
 * live session, no context switch for the reader either. FSRS does not care
 * what order due cards are cleared in, so grouping them costs nothing. It is a
 * PREFERENCE, never a filter — once the origin is drained the pick falls through
 * to the plain rule, so you cannot get trapped on one site.
 *
 * Origin, exactly as the browser defines it: scheme + host + port. Not the
 * registrable domain — zhuanlan.zhihu.com and www.zhihu.com share one but are
 * different products with different content, and moving between them is the
 * context switch this exists to avoid. Being the browser's own notion, it needs
 * no suffix table and is right for localhost:3000 and a tunnel hostname alike.
 *
 * Kept pure and separate from the IndexedDB read so the choice can be tested
 * without a browser, and so the local deck and the cloud cannot drift apart on
 * what "next" means.
 */

export type DueCandidate = { url: string; title?: string; card: { due: string | Date } };

/** The origin of a url — scheme, host, port — or null when it will not parse. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** The host of a url, or null when it will not parse. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Public suffixes that take two labels, so the registrable domain is three.
 *
 * Not the full Public Suffix List — that is a 200 KB dependency for a preference
 * — but the entries that actually occur in real decks: country second-levels,
 * and the hosting platforms where every subdomain is a different owner. A
 * suffix missing here degrades gracefully: two unrelated `*.example.tld` sites
 * get grouped, which costs one extra hop, not a stuck card.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.tw",
  "com.hk",
  "com.sg",
  "com.mx",
  "co.kr",
  "co.in",
  "co.nz",
  "co.za",
  "pages.dev",
  "workers.dev",
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "cloudfront.net",
]);

/**
 * The site a url belongs to: its registrable domain, port dropped, `www.`
 * folded in. `www.zhihu.com` and `zhuanlan.zhihu.com` are one site; so are
 * `docs.google.com` and `console.cloud.google.com`.
 *
 * NOT what the next-card preference uses — that is `originOf`, because those
 * pairs are different products to a reader. This is the coarser grouping for
 * places that want "the same publisher", such as the immersion-site matrix.
 */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname) return null;
  // An IP address has no registrable domain; the whole thing is the site.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;
  const take = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export function pickNextDue<T extends DueCandidate>(
  cards: T[],
  now = Date.now(),
  preferOrigin: string | null = null,
): T | null {
  let best: T | null = null;
  let bestDue = -Infinity;
  let bestSameOrigin = false;
  for (const c of cards) {
    const due = new Date(c.card.due).getTime();
    // NaN from a malformed date fails every comparison, so such a card is
    // skipped rather than being treated as due at the epoch and served forever.
    if (!(due <= now)) continue;
    const sameOrigin = preferOrigin !== null && originOf(c.url) === preferOrigin;
    // Same origin beats a later due date; among equals, the later due date wins.
    if (sameOrigin !== bestSameOrigin ? sameOrigin : due > bestDue) {
      best = c;
      bestDue = due;
      bestSameOrigin = sameOrigin;
    }
  }
  return best;
}
