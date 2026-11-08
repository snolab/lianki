import { describe, expect, it } from "bun:test";
import { RANGE_MAX_LINES } from "@/lib/read/reader-select";
import {
  REVIEW_PARAM,
  decodeReviewRef,
  reviewKey,
  reviewOfHref,
  reviewRef,
  withReview,
} from "@/lib/read/review-ref";

describe("reviewRef", () => {
  it("names the paragraph for a word, a phrase, a sentence and the paragraph", () => {
    expect(reviewRef({ kind: "word", line: 12, t: 3 })).toBe("p12");
    expect(reviewRef({ kind: "phrase", line: 12, t0: 3, t1: 5 })).toBe("p12");
    expect(reviewRef({ kind: "sentence", line: 12, s: 1 })).toBe("p12");
    expect(reviewRef({ kind: "para", line: 12 })).toBe("p12");
  });
  it("names a range by its own words", () => {
    expect(reviewRef({ kind: "range", l0: 3, t0: 0, l1: 4, t1: 7 })).toBe("r3.0-4.7");
  });
  it("has none for a chapter or the book", () => {
    expect(reviewRef({ kind: "chapter", n: 1 })).toBeNull();
    expect(reviewRef({ kind: "book" })).toBeNull();
  });
});

describe("decodeReviewRef", () => {
  it("round-trips", () => {
    for (const u of [
      { kind: "para", line: 0 },
      { kind: "para", line: 4021 },
      { kind: "range", l0: 3, t0: 0, l1: 4, t1: 7 },
      { kind: "range", l0: 5, t0: 2, l1: 5, t1: 9 },
    ] as const)
      expect(decodeReviewRef(reviewRef(u))).toEqual(u);
  });
  it("refuses anything else", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "p",
      "p-1",
      "p01",
      "p1.2",
      "w=1.2",
      "#p=3",
      "r3.5-3.5",
      "r4.0-3.0",
      "r3.9-3.2",
      `r0.0-${RANGE_MAX_LINES + 1}.0`,
      "p12345678",
      "p1 ",
    ])
      expect(decodeReviewRef(bad)).toBeNull();
  });
});

describe("the URL", () => {
  const book = "https://lianki.com/reader/abc?reader=v2#p=40";
  it("sets the ref, keeping the other parameters and the fragment", () => {
    expect(withReview(book, "p12")).toBe("/reader/abc?reader=v2&review=p12#p=40");
    expect(withReview("/reader/abc", "r3.0-4.7")).toBe("/reader/abc?review=r3.0-4.7");
  });
  it("replaces a ref and drops it", () => {
    const on = withReview(book, "p12");
    expect(withReview(on, "p13")).toBe("/reader/abc?reader=v2&review=p13#p=40");
    expect(withReview(on, null)).toBe("/reader/abc?reader=v2#p=40");
    expect(withReview("/reader/abc?review=p1", null)).toBe("/reader/abc");
  });
  it("reads it back, only when it names a review", () => {
    expect(reviewOfHref(withReview(book, "r3.0-4.7"))).toBe("r3.0-4.7");
    expect(reviewOfHref(book)).toBeNull();
    expect(reviewOfHref(`/reader/abc?${REVIEW_PARAM}=nonsense`)).toBeNull();
  });
  it("keys the position by book and ref", () => {
    expect(reviewKey("abc", "p12")).toBe("review:abc:p12");
    expect(reviewKey("abc", "p12")).not.toBe(reviewKey("abd", "p12"));
  });
});
