import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { LANG_TAGS } from "@/lib/constants";

/**
 * The /dev pages' names in the viewer's locale (dictionary `dev-pages`,
 * dev-pages.content.ts): the browser tab title "<name> — Lianki dev" and the
 * page's main heading. unit/dev-pages-i18n.test.ts checks that no /dev page
 * keeps an English title literal.
 */
export type DevPageName =
  | "boxClients"
  | "config"
  | "credits"
  | "flags"
  | "friends"
  | "giftCodes"
  | "levels"
  | "lian"
  | "liveFrontends"
  | "mails"
  | "membership"
  | "newOrder"
  | "permissions"
  | "preview"
  | "swipeAb"
  | "templates"
  | "tokens"
  | "users";

const NO_INDEX = { index: false, follow: false, nocache: true } as const;

/** "<name> — <suffix>" from the dictionary, in `locale`. */
export function devPageTitle(name: DevPageName, locale: string): string {
  const d = getIntlayer("dev-pages", locale as never) as unknown as Record<string, unknown>;
  return `${String(d[name])} — ${String(d.suffix)}`;
}

/** A page's `generateMetadata`: its localized title, never indexed, plus `extra`. */
export function devPageMetadata(name: DevPageName, extra: Metadata = {}) {
  return async (): Promise<Metadata> => ({
    title: devPageTitle(name, await appLocale()),
    robots: NO_INDEX,
    ...extra,
  });
}

/** One of the dictionary's strings (a page heading, or a small page's text) and its language tag, in the viewer's locale. */
export async function devPageText(
  name: DevPageName | "myLevel" | "lianIntro",
): Promise<{ text: string; lang: string }> {
  const locale = await appLocale();
  const d = getIntlayer("dev-pages", locale as never) as unknown as Record<string, unknown>;
  return { text: String(d[name]), lang: LANG_TAGS[locale] ?? locale };
}
