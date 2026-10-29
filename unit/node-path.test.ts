import { describe, expect, it } from "bun:test";
import {
  MAX_NODE_PATH,
  agentIdOf,
  commonAncestor,
  completeNode,
  isWithin,
  lineNode,
  mayAddress,
  nodeHue,
  nodePath,
  parseAddress,
  pathLabel,
  routeTo,
} from "@lianki/debug-chat/node-path";
import { parseControllerMessage, parsePageMessage } from "@/lib/dev-eval";

describe("nodePath: validation", () => {
  it("normalises slashes, › and spaces", () => {
    expect(nodePath("/words/prefetch")).toBe("/words/prefetch");
    expect(nodePath("  /words › prefetch ")).toBe("/words/prefetch");
    expect(nodePath("words/prefetch/")).toBe("/words/prefetch");
    expect(nodePath("//words//prefetch")).toBe("/words/prefetch");
    expect(nodePath("/")).toBe("/");
  });
  it("refuses other characters, dot segments, overlong paths and non-strings", () => {
    for (const bad of ["/words/pre fetch", "/a/../b", "/./a", "/a?b", "/<x>", "", "   ", 42, null])
      expect(nodePath(bad)).toBeUndefined();
    expect(nodePath(`/${"a".repeat(MAX_NODE_PATH - 1)}`)).toHaveLength(MAX_NODE_PATH);
    expect(nodePath(`/${"a".repeat(MAX_NODE_PATH)}`)).toBeUndefined();
  });
  it("agentIdOf trims, caps at 40, and keeps a plain charset", () => {
    expect(agentIdOf("  prefetcher ")).toBe("prefetcher");
    expect(agentIdOf("x".repeat(50))).toHaveLength(40);
    expect(agentIdOf("a/b")).toBeUndefined();
    expect(agentIdOf("<script>")).toBeUndefined();
    expect(agentIdOf(7)).toBeUndefined();
  });
});

describe("node routing rules", () => {
  it("isWithin and commonAncestor", () => {
    expect(isWithin("/words/prefetch", "/words")).toBe(true);
    expect(isWithin("/wordsmith", "/words")).toBe(false);
    expect(isWithin("/anything", "/")).toBe(true);
    expect(commonAncestor("/words/prefetch", "/words/audio")).toBe("/words");
    expect(commonAncestor("/words", "/home")).toBe("/");
  });
  it("routeTo: exact, ancestors observe, siblings and descendants do not, legacy is the root", () => {
    expect(routeTo("/words/prefetch", "/words/prefetch")).toBe("direct");
    expect(routeTo("/words", "/words/prefetch")).toBe("observed");
    expect(routeTo(undefined, "/words/prefetch")).toBe("observed");
    expect(routeTo("/", undefined)).toBe("direct");
    expect(routeTo(undefined, undefined)).toBe("direct");
    expect(routeTo("/words/audio", "/words/prefetch")).toBeNull();
    expect(routeTo("/words/prefetch/img", "/words/prefetch")).toBeNull();
    expect(routeTo("/words", undefined)).toBeNull();
  });
  it("mayAddress: subtree, upward, granted, refused", () => {
    expect(mayAddress("/words", "/words/prefetch")).toEqual({ ok: true, via: "subtree" });
    expect(mayAddress("/words/prefetch", "/words")).toEqual({ ok: true, via: "upward" });
    expect(mayAddress("/words/prefetch", "/")).toEqual({ ok: true, via: "upward" });
    const grants = [{ from: "/words", to: "/home", until: 2000 }];
    expect(mayAddress("/words/prefetch", "/home/x", grants, 1000)).toEqual({
      ok: true,
      via: "grant",
    });
    expect(mayAddress("/words/prefetch", "/home/x", grants, 3000)).toEqual({
      ok: false,
      error: "out of scope: needs a grant from /",
    });
    expect(mayAddress("/words/prefetch", "/words/audio")).toEqual({
      ok: false,
      error: "out of scope: needs a grant from /words",
    });
  });
});

describe("addressing in the input", () => {
  it("parseAddress reads a leading @node", () => {
    expect(parseAddress("@/words › prefetch more please")).toEqual({
      to: "/words/prefetch",
      text: "more please",
      complete: true,
    });
    expect(parseAddress("@/words/prefetch hi")).toEqual({
      to: "/words/prefetch",
      text: "hi",
      complete: true,
    });
    expect(parseAddress("@/wor")).toEqual({ to: "/wor", text: "", complete: false });
    expect(parseAddress("@/words ›")).toEqual({ to: "/words", text: "", complete: false });
    expect(parseAddress("@/ to main")).toEqual({ to: "/", text: "to main", complete: true });
    expect(parseAddress("hello @/words")).toBeNull();
    expect(parseAddress("@someone hi")).toBeNull();
  });
  it("completeNode offers the listeners' nodes under what is typed", () => {
    const nodes = ["/words/prefetch", "/words", "/home", "/"];
    expect(completeNode("@/", nodes)).toEqual(["/home", "/words", "/words/prefetch"]);
    expect(completeNode("@/words › pre", nodes)).toEqual(["/words/prefetch"]);
    expect(completeNode("@/x", nodes)).toEqual([]);
  });
});

describe("rendering a line's node", () => {
  it("an agent line shows its taskPath as '/words › prefetch'", () => {
    expect(pathLabel("/words/prefetch")).toBe("/words › prefetch");
    expect(pathLabel("/")).toBe("/");
    const n = lineNode({ from: "agent", taskPath: "/words/prefetch" });
    expect(n?.subtitle).toBe("/words › prefetch");
    expect(n?.border).toBe(`oklch(0.7 0.09 ${nodeHue("/words/prefetch")})`);
  });
  it("agent → agent is tagged 'from → to'; the owner's own line '→ to'", () => {
    expect(lineNode({ from: "agent", taskPath: "/a/b", to: "/c" })?.subtitle).toBe("/a › b → /c");
    expect(lineNode({ from: "owner", to: "/words/prefetch" })?.subtitle).toBe(
      "→ /words › prefetch",
    );
  });
  it("no taskPath and no target: nothing (the line is unchanged)", () => {
    expect(lineNode({ from: "agent" })).toBeNull();
    expect(lineNode({ from: "owner", to: "/" })).toBeNull();
    // An owner line's taskPath (never sent) is ignored.
    expect(lineNode({ from: "owner", taskPath: "/x" })).toBeNull();
  });
  it("different paths get different hues, the same path the same one", () => {
    expect(nodeHue("/words/prefetch")).toBe(nodeHue("/words/prefetch"));
    expect(nodeHue("/words/prefetch")).not.toBe(nodeHue("/words/audio"));
  });
});

describe("wire validation of node fields", () => {
  it("say: a path `to` is a node, taskPath/agentId are cleaned, a bad path is an error", () => {
    expect(
      parseControllerMessage(
        JSON.stringify({
          type: "say",
          text: "hi",
          to: "/words › audio",
          taskPath: " /words/prefetch ",
          agentId: " pf ",
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "say",
        text: "hi",
        node: "/words/audio",
        taskPath: "/words/prefetch",
        agentId: "pf",
      },
    });
    expect(
      parseControllerMessage(JSON.stringify({ type: "say", text: "hi", to: "a@b.c" })),
    ).toEqual({ ok: true, value: { type: "say", text: "hi", to: "a@b.c" } });
    expect(
      parseControllerMessage(JSON.stringify({ type: "say", text: "hi", taskPath: "/a b" })).ok,
    ).toBe(false);
    expect(parseControllerMessage(JSON.stringify({ type: "say", text: "hi", to: "/.." })).ok).toBe(
      false,
    );
    // "/" is the main thread: no node.
    expect(parseControllerMessage(JSON.stringify({ type: "say", text: "hi", to: "/" }))).toEqual({
      ok: true,
      value: { type: "say", text: "hi" },
    });
  });
  it("grant needs two node paths; chat keeps a valid `to` only", () => {
    expect(
      parseControllerMessage(JSON.stringify({ type: "grant", from: "/a", to: "/b", ms: 5 })),
    ).toEqual({ ok: true, value: { type: "grant", from: "/a", to: "/b", ms: 5 } });
    expect(parseControllerMessage(JSON.stringify({ type: "grant", from: "/a" })).ok).toBe(false);
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "x", to: "/w" })),
    ).toEqual({ type: "chat", id: "1", text: "x", to: "/w" });
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "x", to: "/a b" })),
    ).toEqual({ type: "chat", id: "1", text: "x" });
  });
});

describe("the agent's avatar names the assignee", () => {
  it("agentId over the label; no agentId keeps the label", async () => {
    const { lineAvatar } = await import("@lianki/debug-chat/avatar-rules");
    const base = { id: "1", from: "agent" as const, label: "main lane", text: "x", at: 0 };
    expect(lineAvatar({ ...base, agentId: "prefetcher" }, {}).name).toBe("prefetcher");
    expect(lineAvatar(base, {}).name).toBe("main lane");
  });
});
