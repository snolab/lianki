import { describe, expect, it } from "bun:test";
import words from "@/app/(app)/words/page.content";
import wordsImportAnkiweb from "@/app/(app)/words/import/ankiweb.content";
import bottomNav from "@/app/components/bottom-nav.content";
import learningPartner from "@/app/components/learning-partner.content";
import devSwitch from "@/app/components/dev-switch.content";
import liveView from "@/app/components/live-view.content";
import reviewPage from "@/app/(app)/review/page.content";
import navHome from "@/app/(app)/home/page.content";
import appShell from "@/app/components/app-shell.content";
import landing from "@/app/[locale]/page.content";
import learn from "@/app/(app)/learn/page.content";
import polyglot from "@/app/(app)/polyglot/page.content";
import selfIntro from "@/app/(app)/self-intro/page.content";
import wordsImport from "@/app/(app)/words/import/page.content";
import { describeKeys, flattenContext, keyContext } from "@/lib/i18n-context";

// Owner rule (2026-10-30): a short string is never translated on its own —
// "Undo", "New swipe" or "Experimental" each read several ways. Every key
// carries context (where it appears, what it is for, how it is used) in the
// dictionary's description, which `intlayer fill` and translating agents read
// together with the source text. docs/i18n.md.

describe("describeKeys / keyContext", () => {
  it("round-trips one line per key, whitespace folded", () => {
    const d = describeKeys("About.", { a: "Button  on\nthe toolbar.", b: "Heading." });
    expect(d.startsWith("About.\n")).toBe(true);
    expect(keyContext(d)).toEqual({ a: "Button on the toolbar.", b: "Heading." });
  });

  it("reads nested context back as group.key lines", () => {
    const flat = flattenContext({ nav: { home: "Sidebar link." }, a: { b: { c: "Deep." } } });
    expect(flat).toEqual({ "nav.home": "Sidebar link.", "a.b.c": "Deep." });
    expect(keyContext(describeKeys("About.", flat))).toEqual(flat);
  });

  it("reads nothing from a description without per-key context", () => {
    expect(keyContext(undefined)).toEqual({});
    expect(keyContext("Just a sentence.")).toEqual({});
  });
});

describe.each([
  ["words-page", words],
  ["words-import-ankiweb", wordsImportAnkiweb],
  ["bottom-nav", bottomNav],
  ["learning-partner", learningPartner],
  ["dev-switch", devSwitch],
  ["live-view", liveView],
  ["review-page", reviewPage],
  ["nav-home", navHome],
  ["app-shell", appShell],
  ["landing-page", landing],
  ["learn-page", learn],
  ["polyglot-page", polyglot],
  ["self-intro-page", selfIntro],
  ["words-import", wordsImport],
])("%s", (_name, dict) => {
  // Translation leaves, nested groups included, keyed `group.key`.
  type Node = { nodeType?: string; translation?: Record<string, string> };
  const leaves = (node: Record<string, unknown>, prefix = ""): [string, Node][] =>
    Object.entries(node).flatMap(([k, v]) =>
      (v as Node)?.nodeType === "translation"
        ? [[prefix + k, v as Node] as [string, Node]]
        : v && typeof v === "object" && !(v as Node).nodeType
          ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
          : [],
    );
  const byKey = Object.fromEntries(leaves(dict.content as Record<string, unknown>));
  const keys = Object.keys(byKey);
  const context = keyContext(dict.description);
  const en = (k: string) => byKey[k].translation!.en;

  it("gives every key its translation context", () => {
    expect(keys.filter((k) => !context[k])).toEqual([]);
  });

  it("has no context left for a key that is gone", () => {
    expect(Object.keys(context).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it("says more than the string itself: where, what for, how (5+ words)", () => {
    const thin = keys.filter((k) => {
      const c = context[k] ?? "";
      return c.split(/\s+/).length < 5 || c.trim() === en(k).trim();
    });
    expect(thin).toEqual([]);
  });
});
