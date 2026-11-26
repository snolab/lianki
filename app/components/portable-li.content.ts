import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import { PORTABLE_LI_CONTEXT, PORTABLE_LI_STRINGS } from "@/src/portable-li-strings";
import { PILL_CHAT_LOCALES } from "@/src/pill-chat-strings";
const content = Object.fromEntries(
  Object.keys(PORTABLE_LI_CONTEXT).map((key) => [
    key,
    t(
      Object.fromEntries(
        PILL_CHAT_LOCALES.map((locale) => [
          locale,
          PORTABLE_LI_STRINGS[locale][key as keyof typeof PORTABLE_LI_CONTEXT],
        ]),
      ) as Record<(typeof PILL_CHAT_LOCALES)[number], string>,
    ),
  ]),
);
export default {
  key: "portable-li",
  content,
  title: "Portable Li global consent and chat panel",
  description: describeKeys(
    "Global, browser-local opt-in and site exclusions for portable Li. This is a chat-only UI, not account authority.",
    PORTABLE_LI_CONTEXT,
  ),
} satisfies DeclarationContent;
