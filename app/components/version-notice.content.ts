import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import {
  VERSION_NOTICE_CONTEXT,
  VERSION_NOTICE_LOCALES,
  VERSION_NOTICE_STRINGS,
  type VersionNoticeStrings,
} from "./version-notice-strings";

/**
 * The "new version" pill (VersionNotice.tsx). The strings live in
 * version-notice-strings.ts, because the pill mounts outside the Intlayer client
 * provider; this dictionary declares the same strings, with context, for
 * `intlayer fill`.
 */
const tr = (k: keyof VersionNoticeStrings) =>
  t(
    Object.fromEntries(
      VERSION_NOTICE_LOCALES.map((l) => [l, VERSION_NOTICE_STRINGS[l][k]]),
    ) as Record<(typeof VERSION_NOTICE_LOCALES)[number], string>,
  );

const dictionary = {
  key: "version-notice",
  content: {
    refresh: tr("refresh"),
    autoClean: tr("autoClean"),
    autoDirty: tr("autoDirty"),
  },
} satisfies DeclarationContent;

export default {
  ...dictionary,
  title: "The new-version pill",
  description: describeKeys(
    "The pill shown on every page after a deploy changed the page's code: one tap reloads it.",
    VERSION_NOTICE_CONTEXT,
  ),
} satisfies DeclarationContent;
