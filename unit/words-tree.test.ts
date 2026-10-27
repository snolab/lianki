import { describe, expect, test } from "bun:test";
import { applyDrop, descendants, flatten, projectDrop, visible } from "@/lib/words/tree";

const n = (id: string, parentId: string | null = null) => ({ id, parentId });

describe("word-list tree", () => {
  const nodes = [n("fr"), n("a", "fr"), n("b", "fr"), n("ja"), n("c", "ja")];

  test("flattens depth-first, orphans and cycles still shown once", () => {
    expect(flatten(nodes).map((x) => `${x.id}:${x.depth}`)).toEqual([
      "fr:0",
      "a:1",
      "b:1",
      "ja:0",
      "c:1",
    ]);
    expect(flatten([n("x", "gone")]).map((x) => x.depth)).toEqual([0]);
    expect(flatten([n("p", "q"), n("q", "p")]).length).toBe(2);
  });

  test("descendants and collapsed rows", () => {
    const flat = flatten(nodes);
    expect(descendants(flat, "fr")).toEqual(["a", "b"]);
    expect(visible(flat, new Set(["fr"])).map((x) => x.id)).toEqual(["fr", "ja", "c"]);
  });

  test("dragging right nests under the row above; left un-nests", () => {
    const flat = flatten([n("fr"), n("a"), n("b")]);
    // Drag b right by one indent while over itself: becomes a child of a.
    expect(projectDrop(flat, "b", "b", 24, 24)).toEqual({ depth: 1, parentId: "a" });
    // Cannot nest two levels deep at once.
    expect(projectDrop(flat, "b", "b", 96, 24)).toEqual({ depth: 1, parentId: "a" });
    const nested = flatten([n("fr"), n("a", "fr"), n("b", "fr")]);
    expect(projectDrop(nested, "b", "b", -24, 24)).toEqual({ depth: 0, parentId: null });
    // Staying at depth 1 below a sibling keeps the sibling's parent.
    expect(projectDrop(nested, "b", "b", 0, 24)).toEqual({ depth: 1, parentId: "fr" });
  });

  test("a dropped group carries its subtree; collapsed subtrees stay put", () => {
    const flat = flatten(nodes);
    // Drag the "ja" group (its child c is hidden during the drag) above "fr".
    const items = flat.filter((x) => x.id !== "c");
    expect(applyDrop(flat, items, "ja", "fr", null)).toEqual([
      { id: "ja", parentId: null },
      { id: "c", parentId: "ja" },
      { id: "fr", parentId: null },
      { id: "a", parentId: "fr" },
      { id: "b", parentId: "fr" },
    ]);
  });
});
