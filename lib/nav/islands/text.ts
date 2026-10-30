"use client";

/**
 * The nav islands' strings: bottom-nav, the page names (landing-page.nav +
 * app-shell.nav, merged as AppShell does) and the partner's name. All from
 * intlayer, so nothing here is a hardcoded label.
 */
import { useIntlayer } from "next-intlayer";
import { APP_NAV, type NavGroup } from "@/lib/app-nav";

/** An intlayer node, or a plain string, as text. */
export const str = (n: unknown): string => {
  if (n == null) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  // An IntlayerNode: a React node carrying its text as `.value` (or its props').
  const o = n as { value?: unknown; props?: { value?: unknown; children?: unknown } };
  const v = o.value ?? o.props?.value ?? o.props?.children;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};

export type NavText = ReturnType<typeof useNavText>;

export function useNavText() {
  const b = useIntlayer("bottom-nav") as unknown as Record<string, unknown>;
  const shell = useIntlayer("app-shell") as unknown as {
    nav: Record<string, unknown>;
    groups: Record<NavGroup, unknown>;
  };
  const landing = useIntlayer("landing-page") as unknown as { nav?: Record<string, unknown> };
  const partner = useIntlayer("learning-partner") as unknown as { name: unknown };
  const t = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, str(v)])) as Record<
    | "navigation"
    | "home"
    | "menu"
    | "search"
    | "searchPlaceholder"
    | "closeSearch"
    | "close"
    | "noResults"
    | "loading"
    | "create"
    | "holdForCreate"
    | "groupGo"
    | "groupWords"
    | "groupCards"
    | "groupTree"
    | "wordsFromDeck"
    | "addLink"
    | "addThisUrl"
    | "pasteLink"
    | "importCards"
    | "aiWords"
    | "due"
    | "offline"
    | "pending"
    | "synced"
    | "pinned"
    | "recent"
    | "pin"
    | "unpin"
    | "breadcrumb",
    string
  >;
  const pages: Record<string, string> = {};
  for (const item of APP_NAV)
    pages[item.key] = str(shell.nav?.[item.key] ?? landing.nav?.[item.key]) || item.key;
  const groups = Object.fromEntries(
    Object.entries(shell.groups ?? {}).map(([k, v]) => [k, str(v)]),
  ) as Record<NavGroup, string>;
  return { ...t, pages, groups, partner: str(partner.name) };
}
