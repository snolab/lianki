import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import {
  PILL_CHAT_CONTEXT,
  PILL_CHAT_LOCALES,
  PILL_CHAT_STRINGS,
  type PillChatStrings,
} from "@/src/pill-chat-strings";

/**
 * Li chat from the userscript pill (docs/userscript-li-chat.md): the trust
 * prompt, the sites list and the pill's Li entry. The strings live in
 * src/pill-chat-strings.ts, because the userscript cannot load intlayer; this
 * dictionary declares the same strings, with their context, for `intlayer fill`.
 */
const tr = (k: keyof PillChatStrings) =>
  t(
    Object.fromEntries(PILL_CHAT_LOCALES.map((l) => [l, PILL_CHAT_STRINGS[l][k]])) as Record<
      (typeof PILL_CHAT_LOCALES)[number],
      string
    >,
  );

const dictionary = {
  key: "pill-chat",
  content: {
    liTitle: tr("liTitle"),
    promptTitle: tr("promptTitle"),
    promptBody: tr("promptBody"),
    promptWarn: tr("promptWarn"),
    allowOnce: tr("allowOnce"),
    allowAlways: tr("allowAlways"),
    neverHere: tr("neverHere"),
    notNow: tr("notNow"),
    sitesTitle: tr("sitesTitle"),
    sitesMenu: tr("sitesMenu"),
    sitesEmpty: tr("sitesEmpty"),
    sitesAllowed: tr("sitesAllowed"),
    sitesNever: tr("sitesNever"),
    forget: tr("forget"),
    close: tr("close"),
    blocked: tr("blocked"),
    openLianki: tr("openLianki"),
  },
};

const context: Record<keyof typeof dictionary.content, string> = PILL_CHAT_CONTEXT;

export default {
  ...dictionary,
  title: "Userscript pill — Li chat trust prompt and sites list",
  description: describeKeys(
    "The userscript's Li chat on other websites: a one-time per-site trust prompt, the list of allowed/blocked sites, and the pill's Li button. Li and lianki.com are product names: keep them.",
    context,
  ),
} satisfies DeclarationContent;
