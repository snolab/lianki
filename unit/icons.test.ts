/** app/components/icons.tsx: decorative or labelled, regular or filled, and the seal. */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, SealIcon } from "@/app/components/icons";

test("an icon without a label is hidden from screen readers", () => {
  const html = renderToStaticMarkup(createElement(Icon, { name: "house" }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('data-icon="house"');
});

test("a labelled icon is an image with that name; fill uses the filled paths", () => {
  const regular = renderToStaticMarkup(createElement(Icon, { name: "house", label: "Home" }));
  const filled = renderToStaticMarkup(
    createElement(Icon, { name: "house", label: "Home", weight: "fill" }),
  );
  expect(regular).toContain('role="img"');
  expect(regular).toContain('aria-label="Home"');
  expect(filled).not.toBe(regular);
});

test("the seal carves the filled icon out of a red stamp through a mask", () => {
  const html = renderToStaticMarkup(createElement(SealIcon, { name: "house" }));
  expect(html).toContain("<mask");
  expect(html).toMatch(/mask="url\(#lk-seal-[\w-]+\)"/);
});
