import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import {
  USERSCRIPT_CONTEXT,
  USERSCRIPT_LOCALES,
  USERSCRIPT_STRINGS,
  type UserscriptLocale,
  type UserscriptStrings,
} from "@/src/userscript-strings";

/**
 * The userscript's own strings (the LiCards panel and the floating pill on any
 * website). They live in src/userscript-strings.ts, because the userscript
 * cannot load intlayer; this dictionary declares the same strings, with their
 * context, for `intlayer fill`. Edit them there.
 */
const tr = (k: keyof UserscriptStrings) =>
  t(
    Object.fromEntries(USERSCRIPT_LOCALES.map((l) => [l, USERSCRIPT_STRINGS[l][k]])) as Record<
      UserscriptLocale,
      string
    >,
  );

const content = Object.fromEntries(
  (Object.keys(USERSCRIPT_CONTEXT) as (keyof UserscriptStrings)[]).map((k) => [k, tr(k)]),
) as Record<keyof UserscriptStrings, ReturnType<typeof tr>>;

const dictionary = { key: "userscript-ui", content };

const context: Record<keyof typeof content, string> = USERSCRIPT_CONTEXT;

export default {
  ...dictionary,
  title: "Userscript — the LiCards panel and floating pill on any website",
  description: describeKeys(
    "The Lianki userscript: an add-on that runs on every website, with a small floating pill and a LiCards panel (Alt+F) that saves the page as a spaced-repetition card or reviews it with the grades Again / Hard / Good / Easy, plus video speed buttons. Picked by the browser's language. LiCards (zh: 链卡) and Lianki are product names; keep key names and placeholders.",
    context,
  ),
} satisfies DeclarationContent;
