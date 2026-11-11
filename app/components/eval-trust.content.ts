import { t, type DeclarationContent } from "intlayer";
import { describeKeys } from "@/lib/i18n-context";
import {
  EVAL_TRUST_CONTEXT,
  EVAL_TRUST_STRINGS,
} from "../../packages/debug-chat/src/eval-trust-strings";
const content = Object.fromEntries(
  Object.keys(EVAL_TRUST_CONTEXT).map((key) => [
    key,
    t(
      Object.fromEntries(
        Object.entries(EVAL_TRUST_STRINGS).map(([locale, strings]) => [
          locale,
          strings[key as keyof typeof EVAL_TRUST_CONTEXT],
        ]),
      ),
    ),
  ]),
);
export default {
  key: "eval-trust",
  content,
  description: describeKeys(
    "Developer remote-code pairing, explicit persistent account-and-device trust.",
    EVAL_TRUST_CONTEXT,
  ),
} satisfies DeclarationContent;
