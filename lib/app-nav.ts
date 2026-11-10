/**
 * Single source of truth for the app-shell sidebar.
 *
 * `key` indexes into the label bag the shell receives from the server (the
 * merged `landing-page.nav` + `app-shell.nav` dictionaries), so adding a
 * feature to the sidebar means one entry here plus one label — not an edit to
 * every page under `app/(app)/`.
 *
 * `href` is a bare app path. App links never carry `?lang=`: the locale comes
 * from the `lang` cookie (or Accept-Language), and only an explicit language
 * switch puts `?lang=` in the URL.
 */
import type { IconName } from "@/app/components/icons";
import type { FlagKey } from "@/lib/flags";

export type NavGroup = "main" | "advanced" | "lab" | "data" | "account";

export type NavItem = {
  key: string;
  href: string;
  /** A Phosphor icon, drawn by app/components/icons.tsx. */
  icon: IconName;
  group: NavGroup;
  /**
   * Shown only while this feature flag is on, or to the owner (the page
   * itself 404s otherwise): the server passes the keys to show.
   */
  flag?: FlagKey;
  /**
   * "menu": reached from the account menu (avatar; also pinned at the rail's
   * foot), not the rail. Owner, 2026-11-09: import, data and settings are
   * account things; their URLs stay as they are.
   */
  place?: "menu";
};

// Home is navigation and onboarding; word lists are the main path. The
// page-card features (immersion sites, reviewing pages, the card list with
// its userscript install) sit under the "advanced" group, which the UI names
// LiCards (zh: 链卡) — the product name of turning web pages into cards. The
// group key stays "advanced".
export const APP_NAV: NavItem[] = [
  { key: "home", href: "/home", icon: "house", group: "main" },
  { key: "today", href: "/today", icon: "sparkle", group: "main", flag: "today.goal" },
  { key: "words", href: "/words", icon: "textAa", group: "main" },
  { key: "alphabet", href: "/alphabet", icon: "textAUnderline", group: "main" },
  { key: "learn", href: "/learn", icon: "graduationCap", group: "main" },
  { key: "selfIntro", href: "/self-intro", icon: "userSound", group: "main" },
  { key: "read", href: "/reader", icon: "bookOpen", group: "main" },
  // My books (the user's shelf) and the catalogue it is filled from (owner, 2026-11-10).
  { key: "books", href: "/books", icon: "bookBookmark", group: "main", flag: "books.mine" },
  { key: "library", href: "/library", icon: "books", group: "main", flag: "library.catalogue" },
  { key: "roadmap", href: "/roadmap", icon: "mapTrifold", group: "main" },
  { key: "sites", href: "/sites", icon: "globe", group: "advanced" },
  { key: "review", href: "/review", icon: "play", group: "advanced" },
  { key: "cards", href: "/list", icon: "cards", group: "advanced" },
  { key: "addNote", href: "/add-note", icon: "plusCircle", group: "advanced" },
  // Experiments (实验室): /lab lists them all; each lives under /lab/<name>.
  { key: "lab", href: "/lab", icon: "flask", group: "lab" },
  { key: "aiVocab", href: "/lab/ai-vocab", icon: "brain", group: "lab" },
  { key: "polyglot", href: "/lab/polyglot", icon: "globeHemisphereWest", group: "lab" },
  // Owner, 2026-11-10: /my is the user's manager for all their own data
  // (profile, preferences, files); first in the account menu after Profile.
  { key: "myData", href: "/my", icon: "folder", group: "account", place: "menu" },
  { key: "import", href: "/import", icon: "uploadSimple", group: "data", place: "menu" },
  { key: "data", href: "/data", icon: "database", group: "data", place: "menu" },
  { key: "preferences", href: "/my/preferences", icon: "gearSix", group: "account", place: "menu" },
  { key: "membership", href: "/membership", icon: "star", group: "account" },
];

/** The nav items this viewer gets: every unflagged one, and flagged ones in `shown`. */
export function visibleNav(shown: readonly string[] = []): NavItem[] {
  return APP_NAV.filter((i) => !i.flag || shown.includes(i.key));
}

/** The rail's (and drawer's) items: the visible ones the account menu does not carry. */
export function railNav(shown: readonly string[] = []): NavItem[] {
  return visibleNav(shown).filter((i) => i.place !== "menu");
}

/** The account menu's page links, in menu order (profile comes first, before these). */
export const MENU_NAV: NavItem[] = APP_NAV.filter((i) => i.place === "menu");

export const NAV_GROUPS: NavGroup[] = ["main", "advanced", "lab", "data", "account"];

/**
 * Which nav item a pathname belongs to. Longest matching href wins so
 * `/reader/abc` highlights Read rather than nothing.
 */
export function activeNavKey(pathname: string): string | null {
  let best: NavItem | null = null;
  for (const item of APP_NAV) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best?.key ?? null;
}
