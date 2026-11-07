/**
 * The reader's way back (app/(app)/read/[id]/reader-back.tsx): the top of the
 * page and the end of the book go to the same parent, in both readers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { READER_PARENT_HREF, ReaderBack } from "@/app/(app)/read/[id]/reader-back";

const href = (html: string) => html.match(/href="([^"]*)"/)?.[1];
const render = (variant: "icon" | "end") =>
  renderToStaticMarkup(createElement(ReaderBack, { variant, label: "Back to books" }));

describe("ReaderBack", () => {
  test("top and end point to the same parent", () => {
    expect(READER_PARENT_HREF).toBe("/read");
    for (const v of ["icon", "end"] as const) expect(href(render(v))).toBe("/read");
  });

  test("the end button shows its label; the icon keeps it for screen readers", () => {
    expect(render("end")).toContain('data-testid="reader-back-end"');
    expect(render("end")).toContain("Back to books");
    expect(render("icon")).toContain('aria-label="Back to books"');
    expect(render("icon")).toContain('data-testid="reader-back"');
  });

  test("the reader renders a top and an end ReaderBack, with the same label", () => {
    const dir = join(import.meta.dir, "../app/(app)/read/[id]");
    for (const [file, top] of [["ReaderV2.tsx", "icon"]] as const) {
      const src = readFileSync(join(dir, file), "utf8");
      const uses = [
        ...src.matchAll(/<ReaderBack variant="(\w+)" label=\{(\w+)\.back\.value\} \/>/g),
      ];
      expect(uses.map((m) => m[1]).sort()).toEqual(["end", top].sort());
      expect(new Set(uses.map((m) => m[2])).size).toBe(1);
    }
  });
});
