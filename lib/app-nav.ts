/**
 * Single source of truth for the app-shell sidebar.
 *
 * `key` indexes into the label bag the shell receives from the server (the
 * merged `landing-page.nav` + `app-shell.nav` dictionaries), so adding a
 * feature to the sidebar means one entry here plus one label — not an edit to
 * every page under `app/(app)/`.
 *
 * `href` is a bare app path; the shell runs it through `appHref()` so the
 * `?lang=` app-route locale survives navigation.
 */
export type NavGroup = "main" | "data" | "account";

export type NavItem = {
  key: string;
  href: string;
  icon: string;
  group: NavGroup;
};

export const APP_NAV: NavItem[] = [
  { key: "review", href: "/next", icon: "▶", group: "main" },
  { key: "cards", href: "/list", icon: "📚", group: "main" },
  { key: "learn", href: "/learn", icon: "🎓", group: "main" },
  { key: "roadmap", href: "/roadmap", icon: "🗺", group: "main" },
  { key: "aiVocab", href: "/ai-vocab", icon: "🧠", group: "main" },
  { key: "polyglot", href: "/polyglot", icon: "🌍", group: "main" },
  { key: "selfIntro", href: "/self-intro", icon: "🗣", group: "main" },
  { key: "read", href: "/read", icon: "📖", group: "main" },
  { key: "addNote", href: "/add-note", icon: "➕", group: "main" },
  { key: "import", href: "/import", icon: "⬆", group: "data" },
  { key: "data", href: "/data", icon: "💾", group: "data" },
  { key: "preferences", href: "/preferences", icon: "⚙", group: "account" },
  { key: "membership", href: "/membership", icon: "★", group: "account" },
];

export const NAV_GROUPS: NavGroup[] = ["main", "data", "account"];

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
