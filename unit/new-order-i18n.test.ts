import { describe, expect, it } from "bun:test";
import newOrder from "@/app/(app)/words/new-order.content";
import { keyContext } from "@/lib/i18n-context";

// The same checks as unit/i18n-context.test.ts, for the new-order dictionary
// (docs/i18n.md): every key has context that says more than the string.
describe("new-order dictionary", () => {
  const content = newOrder.content as Record<
    string,
    { nodeType?: string; translation: Record<string, string> }
  >;
  const keys = Object.keys(content).filter((k) => content[k]?.nodeType === "translation");
  const context = keyContext(newOrder.description);

  it("gives every key its translation context, and none to a key that is gone", () => {
    expect(keys.filter((k) => !context[k])).toEqual([]);
    expect(Object.keys(context).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("says more than the string itself (5+ words)", () => {
    const thin = keys.filter((k) => {
      const c = context[k] ?? "";
      return c.split(/\s+/).length < 5 || c.trim() === content[k].translation.en.trim();
    });
    expect(thin).toEqual([]);
  });

  it("has English, Chinese and Japanese for every key", () => {
    expect(keys.filter((k) => !["en", "zh", "ja"].every((l) => content[k].translation[l]))).toEqual(
      [],
    );
  });
});
