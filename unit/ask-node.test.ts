/**
 * Ask cards on their node (scripts/dev/ask-node.ts): a lane's ask names its
 * node; the question and the tapped answer become notes on it.
 */
import { describe, expect, it } from "bun:test";
import { askAnswer, askNode, askQuestions, nodeNote } from "@/scripts/dev/ask-node";

const ask = ["--q", "Ship?", "--opt", "Yes", "--opt", "No"];

describe("askNode", () => {
  it("takes --node out of the arguments, else LIANKI_TASK_PATH", () => {
    expect(askNode(["--node", "/a/b", ...ask], {}, "codex")).toEqual({ node: "/a/b", rest: ask });
    expect(askNode(ask, { LIANKI_TASK_PATH: " /env " }, "codex")).toEqual({
      node: "/env",
      rest: ask,
    });
    expect(askNode(ask, {}, undefined)).toEqual({ rest: ask });
  });
  it("a lane must name one; a bad path is refused", () => {
    expect(askNode(ask, {}, "codex")).toBeInstanceOf(Error);
    expect(askNode(ask, { LIANKI_TASK_PATH: " " }, "codex")).toBeInstanceOf(Error);
    expect(askNode(["--node"], {}, undefined)).toBeInstanceOf(Error);
    expect(askNode(["--node", "slug"], {}, undefined)).toBeInstanceOf(Error);
  });
  it("lists the questions", () => {
    expect(askQuestions([...ask, "--q", "Now?", "--opt", "x"])).toEqual(["Ship?", "Now?"]);
  });
});

describe("askAnswer", () => {
  it("reads eval.ts, the lianki CLI and its envelope", () => {
    expect(askAnswer('{"type":"answered","labels":{"0":["Yes"]}}\n')).toBe("Yes");
    expect(askAnswer('{"type":"answered","answer":["A","B"]}')).toBe("A, B");
    expect(askAnswer('{"id":"1","answer":{"labels":{"0":["No"],"1":["x"]}}}')).toBe("No, x");
    expect(askAnswer('noise\n{"ok":true,"data":{"answer":{"labels":"Later"}}}')).toBe("Later");
  });
  it("is null when nothing was tapped", () => {
    expect(askAnswer('{"type":"asked","askId":"a"}')).toBeNull();
    expect(askAnswer('{"answer":null}')).toBeNull();
    expect(askAnswer('{"type":"answered","labels":{"0":[" "]}}')).toBeNull();
    expect(askAnswer('{"type":"answered","labels":7}')).toBeNull();
    expect(askAnswer("Yes")).toBeNull();
    expect(askAnswer("null")).toBeNull();
  });
});

describe("nodeNote", () => {
  it("keeps title and status, writes as the lane or the creator, and caps the note", () => {
    const node = { id: "/a", task: "A: a", status: "doing" as const, creator: "w" };
    expect(nodeNote(node, "ask: Ship?", "codex")).toEqual({
      id: "/a",
      agent: "codex",
      task: "A: a",
      status: "doing",
      note: "ask: Ship?",
    });
    expect(nodeNote(node, "x".repeat(400)).note).toHaveLength(280);
    expect(nodeNote(node, "n", " ").agent).toBe("w");
  });
});
