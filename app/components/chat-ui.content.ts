import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import {
  CHAT_LOCALES,
  EXTRA,
  EXTRA_CONTEXT,
  LEGACY_CONTEXT,
  LEGACY_KEYS,
  OTHER_LEGACY,
  type ChatExtra,
  type ChatLocale,
  type LegacyKey,
} from "@lianki/debug-chat/chat-ui-locales";
import { UI_EN, UI_JA, UI_ZH } from "@lianki/debug-chat/ui-strings";

/**
 * The Learning Partner chat's user-facing strings (docs/i18n.md). They live in
 * packages/debug-chat/src/chat-ui-locales.ts (and ui-strings.ts for en / zh /
 * ja), because the chat widget runs outside intlayer; this dictionary declares
 * the same strings, with their context, for `intlayer fill`. Edit them there.
 */
const legacy = (k: LegacyKey) =>
  t(
    Object.fromEntries(
      CHAT_LOCALES.map((l) => [
        l,
        l === "en" ? UI_EN[k] : l === "zh" ? UI_ZH[k] : l === "ja" ? UI_JA[k] : OTHER_LEGACY[l][k],
      ]),
    ) as Record<ChatLocale, string>,
  );
const extra = (k: keyof ChatExtra) =>
  t(Object.fromEntries(CHAT_LOCALES.map((l) => [l, EXTRA[l][k]])) as Record<ChatLocale, string>);

const content = {
  ...(Object.fromEntries(LEGACY_KEYS.map((k) => [k, legacy(k)])) as Record<
    LegacyKey,
    ReturnType<typeof legacy>
  >),
  ...(Object.fromEntries(
    (Object.keys(EXTRA.en) as (keyof ChatExtra)[]).map((k) => [k, extra(k)]),
  ) as Record<keyof ChatExtra, ReturnType<typeof extra>>),
};

const dictionary = { key: "chat-ui", content };

const context: Record<keyof typeof content, string> = { ...LEGACY_CONTEXT, ...EXTRA_CONTEXT };

export default {
  ...dictionary,
  title: "Learning Partner chat — the widget's own words",
  description: describeKeys(
    "The Learning Partner chat (Li) of Lianki, a spaced-repetition app for learning languages: a small chat panel on every page where the learner talks or types with an AI partner, with a mic, replies read aloud, a menu and question cards. These are the widget's own words (menu rows, tooltips, screen-reader labels, small notes). Li, Lianki and the key names stay as they are.",
    context,
  ),
} satisfies DeclarationContent;
