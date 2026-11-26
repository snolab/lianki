import React from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "bun:test";
import { CardTitle } from "../app/(app)/review/ReviewCardTitle";
import { CONFIG } from "../lib/config";
import { reviewTitleScale, titleWidth } from "../lib/review-title";

const FIT = CONFIG["review.titleFitChars"].default;
const MIN = CONFIG["review.titleMinScalePct"].default;

test("wide characters count double", () => {
  expect(titleWidth("abc")).toBe(3);
  expect(titleWidth("中文")).toBe(4);
  expect(titleWidth("日本語テスト")).toBe(12);
  expect(titleWidth("한국어")).toBe(6);
  expect(titleWidth("ａ")).toBe(2);
});

test("a short title keeps the full size", () => {
  expect(reviewTitleScale("Short title", FIT, MIN)).toBe(1);
  expect(reviewTitleScale("x".repeat(FIT), FIT, MIN)).toBe(1);
});

test("a longer title gets smaller, never below the floor", () => {
  let last = 1;
  for (const n of [FIT + 1, FIT * 1.3, FIT * 1.6, FIT * 3, FIT * 20]) {
    const s = reviewTitleScale("x".repeat(Math.round(n)), FIT, MIN);
    expect(s).toBeLessThanOrEqual(last);
    expect(s).toBeGreaterThanOrEqual(MIN / 100);
    last = s;
  }
  expect(last).toBe(MIN / 100);
});

test("a CJK title shrinks at half the character count", () => {
  const cjk = "长".repeat(FIT / 2 + 10);
  expect(reviewTitleScale(cjk, FIT, MIN)).toBeLessThan(1);
  expect(reviewTitleScale("长".repeat(FIT / 2), FIT, MIN)).toBe(1);
});

test("the title renders whole: no clamp, ellipsis or hidden overflow, and wraps anywhere", () => {
  const long = "这是一个非常非常长的中文标题没有任何空格".repeat(6);
  const html = renderToString(<CardTitle text={long} />);
  expect(html).toContain(long);
  expect(html).toContain("[overflow-wrap:anywhere]");
  expect(html).not.toMatch(/line-clamp|truncate|text-ellipsis|overflow-hidden|whitespace-nowrap/);
  expect(html).toContain(`font-size:${MIN / 100}em`);
});
