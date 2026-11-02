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

export type NavGroup = "main" | "advanced" | "data" | "account";

export type NavItem = {
  key: string;
  href: string;
  /** A Phosphor icon, drawn by app/components/icons.tsx. */
  icon: IconName;
  group: NavGroup;
};

// Home is navigation and onboarding; word lists are the main path. The
// page-card features (immersion sites, reviewing pages, the card list with
// its userscript install) sit under the "advanced" group, which the UI names
// LiCards (zh: 链卡) — the product name of turning web pages into cards. The
// group key stays "advanced".
export const APP_NAV: NavItem[] = [
  { key: "home", href: "/home", icon: "house", group: "main" },
  { key: "words", href: "/words", icon: "textAa", group: "main" },
  { key: "alphabet", href: "/alphabet", icon: "textAUnderline", group: "main" },
  { key: "learn", href: "/learn", icon: "graduationCap", group: "main" },
  { key: "aiVocab", href: "/ai-vocab", icon: "brain", group: "main" },
  { key: "polyglot", href: "/polyglot", icon: "globeHemisphereWest", group: "main" },
  { key: "selfIntro", href: "/self-intro", icon: "userSound", group: "main" },
  { key: "read", href: "/read", icon: "bookOpen", group: "main" },
  { key: "roadmap", href: "/roadmap", icon: "mapTrifold", group: "main" },
  { key: "sites", href: "/sites", icon: "globe", group: "advanced" },
  { key: "review", href: "/next", icon: "play", group: "advanced" },
  { key: "cards", href: "/list", icon: "cards", group: "advanced" },
  { key: "addNote", href: "/add-note", icon: "plusCircle", group: "advanced" },
  { key: "lab", href: "/lab", icon: "flask", group: "advanced" },
  { key: "import", href: "/import", icon: "uploadSimple", group: "data" },
  { key: "data", href: "/data", icon: "database", group: "data" },
  { key: "preferences", href: "/preferences", icon: "gearSix", group: "account" },
  { key: "membership", href: "/membership", icon: "star", group: "account" },
];

export const NAV_GROUPS: NavGroup[] = ["main", "advanced", "data", "account"];

/**
 * Which nav item a pathname belongs to. Longest matching href wins so
 * `/read/abc` highlights Read rather than nothing.
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
