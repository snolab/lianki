// The Docs page's side of the live stream (docs/connections.md, "Live stream").
import { describe, expect, it } from "bun:test";
import { docIdOfPath, looksTruncated, stripImages } from "../src/gdoc-stream";

const ID = "1sjI70BwObP8uDjzenBLOE6H9YcNXa5auMhIQ1eE_WwA";

describe("docIdOfPath", () => {
  it("finds the doc on an editor path, with or without an account", () => {
    expect(docIdOfPath(`/document/d/${ID}/edit`)).toBe(ID);
    expect(docIdOfPath(`/document/u/1/d/${ID}/edit`)).toBe(ID);
  });
  it("refuses anything that is not a document", () => {
    expect(docIdOfPath(`/spreadsheets/d/${ID}/edit`)).toBeNull();
    expect(docIdOfPath("/document/d/short/edit")).toBeNull();
    expect(docIdOfPath("/")).toBeNull();
  });
});

describe("stripImages", () => {
  it("drops images and keeps the text", () => {
    expect(stripImages('<p>a<img src="data:x" alt="y">b</p><IMG src=z>')).toBe("<p>ab</p>");
  });
});

describe("looksTruncated", () => {
  it("doubts only an answer under half the last one", () => {
    expect(looksTruncated("x".repeat(40), "x".repeat(100))).toBe(true);
    expect(looksTruncated("x".repeat(60), "x".repeat(100))).toBe(false);
    expect(looksTruncated("x", null)).toBe(false);
  });
});
