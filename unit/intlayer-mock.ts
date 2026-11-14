import { mock } from "bun:test";
import sealSwitch from "@/app/components/seal-switch.content";
import preferredLangs from "@/app/components/preferred-langs.content";

/**
 * `useIntlayer` for markup rendered in the unit suites, where no intlayer
 * build exists: the given dictionaries in one locale, each leaf as
 * `{ value }` (what the components read). Import before the component.
 */
type Leaf = { nodeType: string; translation: Record<string, string> };
const DICTS: Record<string, { content: Record<string, Leaf> }> = {
  "seal-switch": sealSwitch as never,
  "preferred-langs": preferredLangs as never,
};

export function mockIntlayer(locale = "zh") {
  void mock.module("next-intlayer", () => ({
    useIntlayer: (key: string) => {
      const d = DICTS[key];
      if (!d) throw new Error(`intlayer-mock: no dictionary ${key}`);
      return Object.fromEntries(
        Object.entries(d.content).map(([k, v]) => [k, { value: v.translation[locale] }]),
      );
    },
    useLocale: () => ({ locale }),
  }));
}
