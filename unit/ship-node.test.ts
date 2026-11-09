/**
 * scripts/ship-node.ts: which tree node a shipped PR goes on (--node,
 * LIANKI_TASK_PATH, a "Tree: /path" line), and the report that puts it there.
 */
import { describe, expect, it } from "bun:test";
import { prReport, shipNode, treeLine } from "@/scripts/ship-node";

const base = { argv: [] as string[], env: {}, commitMessage: "feat: x" };

describe("shipNode", () => {
  it("takes --node first, then LIANKI_TASK_PATH, then the commit's Tree line", () => {
    const all = {
      argv: ["--node", "/a/b"],
      env: { LIANKI_TASK_PATH: "/env/x" },
      commitMessage: "feat: y\n\nTree: /c/d\n",
    };
    expect(shipNode(all)).toEqual({ path: "/a/b", from: "flag" });
    expect(shipNode({ ...all, argv: ["--node=/q"] })).toEqual({ path: "/q", from: "flag" });
    expect(shipNode({ ...all, argv: [] })).toEqual({ path: "/env/x", from: "env" });
    expect(shipNode({ ...all, argv: [], env: { LIANKI_TASK_PATH: " " } })).toEqual({
      path: "/c/d",
      from: "commit",
    });
    expect(shipNode(base)).toBeNull();
  });
  it("refuses a bad path", () => {
    expect(shipNode({ ...base, argv: ["--node"] })).toEqual({ error: "--node needs a /path" });
    expect(shipNode({ ...base, argv: ["--node", "slug"] })).toHaveProperty("error");
    expect(shipNode({ ...base, env: { LIANKI_TASK_PATH: "/Bad Path" } })).toHaveProperty("error");
  });
  it("treeLine reads a line of its own, a /path only", () => {
    expect(treeLine("# Doc\n\nTree: /import/any\n")).toBe("/import/any");
    expect(treeLine("see Tree: /x inline")).toBeNull();
    expect(treeLine("Tree: slug")).toBeNull();
    expect(treeLine("Tree: /UPPER")).toBeNull();
  });
});

describe("prReport", () => {
  const node = { id: "/a", task: "A: a", status: "done" as const, creator: "w" };
  it("keeps the title and status and writes as LIANKI_AGENT or the creator", () => {
    expect(prReport(node, 5)).toEqual({
      id: "/a",
      agent: "w",
      task: "A: a",
      status: "done",
      pr: 5,
      note: "PR #5 opened by ship.ts",
    });
    expect(prReport(node, 5, " lane ").agent).toBe("lane");
    expect(prReport(node, 5, " ").agent).toBe("w");
  });
});
