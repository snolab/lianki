import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A slip must never be see-through: the swipe reveal's grade colours sit
// right behind it. Regression: the faded "↓ back" slip used row opacity 0.5.
test("no rule makes a /words list row or slip translucent", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const bad = rules
    .filter(([, sel]) => /\[role="listitem"\]|\.slip(?![-\w])/.test(sel))
    .filter(([, , body]) => /(^|[;\s])opacity\s*:/.test(body))
    .map(([, sel]) => sel.trim());
  expect(bad).toEqual([]);
});
