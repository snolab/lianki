import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import devPages from "@/app/(app)/dev/dev-pages.content";
import { DEV_PAGE_PERMISSION } from "@/lib/dev-page-permissions";

// Owner, 2026-11-09 13:33 JST, on /dev/flags with his account in zh-Hans: "the
// current menu is still English." Every /dev page's tab title and main heading
// come from a dictionary (dev-pages, or the page's own: dev-design,
// dev-roadmap, dev-permissions, new-order), never from an English literal in
// the page. docs/i18n.md.

const DEV = join(import.meta.dir, "../app/(app)/dev");
const LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];
// Pages whose names live in their own dictionaries.
const OWN_DICTIONARY = new Set(["design", "roadmap"]);
const camel = (dir: string) => dir.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

type Leaf = { translation: Record<string, string> };
const content = devPages.content as unknown as Record<string, Leaf>;
const pages = readdirSync(DEV, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("/dev page names come from a dictionary", () => {
  it("covers every /dev page lib/dev-page-permissions.ts lists", () => {
    expect(pages).toEqual(Object.keys(DEV_PAGE_PERMISSION).sort());
  });

  it.each(pages)("/dev/%s has no literal tab title", (dir) => {
    const src = readFileSync(join(DEV, dir, "page.tsx"), "utf8");
    // A static `title: "…"` is a literal; a generateMetadata reads the dictionary.
    expect(src).not.toMatch(/\btitle:\s*["'`]/);
    expect(src).toMatch(/generateMetadata/);
    if (!OWN_DICTIONARY.has(dir)) expect(src).toContain(`devPageMetadata("${camel(dir)}"`);
  });

  it.each(pages)("/dev/%s has no literal main heading", (dir) => {
    const files = readdirSync(join(DEV, dir)).filter((f) => f.endsWith(".tsx"));
    for (const f of files) {
      const src = readFileSync(join(DEV, dir, f), "utf8");
      // The levels gallery's heading names the ladder in both its languages on purpose.
      if (dir === "levels" && f === "LevelGallery.tsx") continue;
      // The preview entry's heading is a status line, not the page's name.
      if (dir === "preview" && f === "PreviewEntryClient.tsx") continue;
      for (const m of src.matchAll(/<h1[^>]*>([^<]*)</g))
        expect({ file: `${dir}/${f}`, text: m[1].trim() }).toEqual({
          file: `${dir}/${f}`,
          text: m[1].trim().startsWith("{") ? m[1].trim() : "",
        });
    }
  });

  it("names every page in all 16 locales, translated (not the English copied)", () => {
    for (const dir of pages.filter((p) => !OWN_DICTIONARY.has(p))) {
      const leaf = content[camel(dir)];
      expect(leaf, dir).toBeDefined();
      expect(Object.keys(leaf.translation).sort()).toEqual([...LOCALES].sort());
      expect(leaf.translation.zh, dir).not.toBe(leaf.translation.en);
      for (const l of LOCALES)
        expect(leaf.translation[l]?.trim().length, `${dir} ${l}`).toBeGreaterThan(0);
    }
  });

  it("names the area itself for the tab title suffix, keeping Lianki", () => {
    for (const l of LOCALES) expect(content.suffix.translation[l]).toContain("Lianki");
    expect(content.suffix.translation.zh).toBe("Lianki 开发");
  });
});
