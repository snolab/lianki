/**
 * The in-site review page (/review), its pure parts: which card, which key,
 * which platform's tutorial, and the bookmarklet.
 *
 * /review is for people without the userscript. It is built beside the bare
 * HTML flow (/api/fsrs/next → /api/fsrs/repeat), never on top of it: it calls
 * the same API the legacy page and the userscript call, unchanged, and renders
 * the result in the site's own layout. Kept free of React and the DOM so the
 * logic is unit-tested (unit/review-ui.test.ts).
 */

export type Rating = 1 | 2 | 3 | 4;

export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

/** The card the page is showing: what /api/fsrs/due or /api/fsrs/get answer. */
export type ReviewCard = { id: string; url: string; title: string | null; due: string | null };

/** One grade button's interval, as /api/fsrs/options gives it ("10m", "3d"). */
export type GradeOption = { rating: Rating; due: string };

/** The card at the top of `GET /api/fsrs/due?limit=1`, or null when nothing is due. */
export function cardFromDue(json: unknown): ReviewCard | null {
  const first = (json as { cards?: unknown[] } | null)?.cards?.[0] as
    | { _id?: unknown; url?: unknown; title?: unknown; card?: { due?: unknown } }
    | undefined;
  if (!first || typeof first._id !== "string" || typeof first.url !== "string") return null;
  return {
    id: first._id,
    url: first.url,
    title: typeof first.title === "string" && first.title ? first.title : null,
    due: typeof first.card?.due === "string" ? first.card.due : null,
  };
}

/** A card named by `GET /api/fsrs/get?url=` (no due date in that answer). */
export function cardFromGet(json: unknown): ReviewCard | null {
  const j = json as { _id?: unknown; url?: unknown; title?: unknown } | null;
  if (!j || typeof j._id !== "string" || typeof j.url !== "string") return null;
  return {
    id: j._id,
    url: j.url,
    title: typeof j.title === "string" && j.title ? j.title : null,
    due: null,
  };
}

/** The four intervals out of `GET /api/fsrs/options?id=`, in grade order. */
export function optionsFrom(json: unknown): GradeOption[] {
  const list = (json as { options?: unknown[] } | null)?.options ?? [];
  const out: GradeOption[] = [];
  for (const o of list as { rating?: unknown; due?: unknown }[]) {
    if (RATINGS.includes(o?.rating as Rating) && typeof o.due === "string")
      out.push({ rating: o.rating as Rating, due: o.due });
  }
  return out.sort((a, b) => a.rating - b.rating);
}

/** Only http(s) pages are cards; anything else is never opened from here. */
export function isHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── API paths: the existing endpoints, called exactly as the legacy page does ──

const q = (v: string) => encodeURIComponent(v);
export const api = {
  due: () => "/api/fsrs/due?limit=1",
  get: (url: string) => `/api/fsrs/get?url=${q(url)}`,
  options: (id: string) => `/api/fsrs/options?id=${q(id)}`,
  stats: () => "/api/fsrs/stats",
  /** The same GET the bare /api/fsrs/repeat page sends. */
  review: (id: string, rating: Rating) => `/api/fsrs/review/${rating}/?id=${q(id)}`,
  delete: (id: string) => `/api/fsrs/delete/?id=${q(id)}`,
  add: () => "/api/fsrs/add",
} as const;

// ── Keyboard ──────────────────────────────────────────────────────────────────

export type KeyAction =
  | { kind: "grade"; rating: Rating }
  | { kind: "delete" }
  | { kind: "open" }
  | { kind: "cancel" };

export type KeyInput = {
  code: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** Focus is in a text field: typing there is never a shortcut. */
  typing?: boolean;
};

/**
 * The legacy grading page's keys, unchanged so muscle memory carries over:
 * 1–4 grade and 5 deletes; a s w d grade and t deletes; h j k l grade and m
 * deletes. Added here: o or Enter opens the card, Escape cancels a delete.
 * Delete only ever asks — the page confirms before it deletes.
 */
const KEYMAP: Record<string, KeyAction> = {
  Digit1: { kind: "grade", rating: 1 },
  Digit2: { kind: "grade", rating: 2 },
  Digit3: { kind: "grade", rating: 3 },
  Digit4: { kind: "grade", rating: 4 },
  Digit5: { kind: "delete" },
  KeyA: { kind: "grade", rating: 1 },
  KeyS: { kind: "grade", rating: 2 },
  KeyW: { kind: "grade", rating: 3 },
  KeyD: { kind: "grade", rating: 4 },
  KeyT: { kind: "delete" },
  KeyH: { kind: "grade", rating: 1 },
  KeyJ: { kind: "grade", rating: 2 },
  KeyK: { kind: "grade", rating: 3 },
  KeyL: { kind: "grade", rating: 4 },
  KeyM: { kind: "delete" },
  KeyO: { kind: "open" },
  Enter: { kind: "open" },
  Escape: { kind: "cancel" },
};

export function keyAction(e: KeyInput): KeyAction | null {
  if (e.typing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  return KEYMAP[e.code] ?? null;
}

/** The key hint shown on each grade button: the digit, as on the legacy page. */
export const gradeKey = (r: Rating) => String(r);

// ── Platform (which tutorial) ────────────────────────────────────────────────

export type Platform = "ios" | "android";

/**
 * iPhone or Android, for the tutorial's wording. Only Android says so in its
 * user agent; iPhones, iPads (which report a Mac) and desktops all get the
 * iPhone steps, and the toggle switches.
 */
export function detectPlatform(userAgent: string): Platform {
  return /android/i.test(userAgent) ? "android" : "ios";
}

/** Where the userscript install guide for that platform lives. */
export function installGuideHref(p: Platform, locale = "en"): string {
  const slug =
    p === "android" ? "2026-02-25-android-installation-guide" : "2025-02-23-ios-installation-guide";
  return `/${locale}/blog/${slug}`;
}

// ── /review?url= (what the bookmarklet opens) ────────────────────────────────

/** The in-site review page for one page's card. */
export function reviewHrefFor(origin: string, pageUrl: string): string {
  return `${origin.replace(/\/+$/, "")}/review?url=${q(pageUrl)}`;
}

/**
 * The bookmarklet. Saved as a bookmark's URL, tapped on any page.
 *
 * It cannot grade on that page itself: the API answers no cross-origin
 * request (no CORS headers, and adding them would change the API), and the
 * session cookie is SameSite=Lax, so a fetch from another site never carries
 * it — Safari blocks third-party cookies outright as well. A bookmarklet that
 * held an API token instead would hand it to every page it ran on. So it does
 * the honest thing: it opens /review for this page's url, a top-level visit
 * where the cookie is sent. The tap that ran it counts as the user's gesture,
 * so the new tab opens; where a browser blocks it anyway, a small Lianki
 * button appears on the page and one more tap on it opens the tab.
 */
export function bookmarkletSource(origin: string): string {
  const base = JSON.stringify(`${origin.replace(/\/+$/, "")}/review?url=`);
  const code = [
    "(function(){",
    `var u=${base}+encodeURIComponent(location.href);`,
    "var w=null;try{w=window.open(u,'_blank')}catch(e){}",
    "if(w)return;",
    "var id='lianki-bm';var o=document.getElementById(id);if(o)o.remove();",
    "var a=document.createElement('a');a.id=id;a.href=u;a.target='_blank';a.rel='noopener';",
    "a.textContent='Lianki: grade this page \\u2197';",
    "a.style.cssText='position:fixed;z-index:2147483647;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));" +
      "padding:12px 16px;border-radius:12px;font:600 16px system-ui,sans-serif;text-decoration:none;" +
      "background:oklch(0.53 0.207 22.3);color:oklch(0.985 0.01 85);box-shadow:0 4px 16px oklch(0 0 0/0.3)';",
    "a.onclick=function(){setTimeout(function(){a.remove()},0)};",
    "document.body.appendChild(a);",
    "})()",
  ].join("");
  return `javascript:${code}`;
}
