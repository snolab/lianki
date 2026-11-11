import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { applyGrantPolish } from "../packages/lianki-cli/chat-polish.mjs";

function executor(result: unknown, code = 0) {
  const calls: any[] = [];
  const spawnProcess: any = (...args: any[]) => {
    calls.push(args);
    const p = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    queueMicrotask(() => {
      p.stdout.end(JSON.stringify(result) + "\n");
      p.emit("exit", code);
    });
    return p;
  };
  return { calls, spawnProcess };
}
test("opt-in multi-line polish calls the existing merge transport with ordered IDs and no pairing", async () => {
  const e = executor({
    type: "edited",
    id: "first",
    text: "修复按钮。",
    passage: { ids: ["first", "second"] },
  });
  await applyGrantPolish(
    "/tmp/review-checkout",
    { id: "first", turnIds: ["first", "second"] },
    "修复按钮。",
    e,
  );
  expect(e.calls[0][0]).toBe("bun");
  expect(e.calls[0][1]).toEqual([
    "/tmp/review-checkout/scripts/dev/eval.ts",
    "edit",
    "--no-pair",
    "--merge",
    "first,second",
    "--text",
    "修复按钮。",
  ]);
  expect(e.calls[0][2].signal).toBeInstanceOf(AbortSignal);
});
test("single-line polish uses edit and refuses unrelated concurrent acknowledgments", async () => {
  const e = executor({ type: "edited", id: "other", text: "修复按钮。" });
  await expect(
    applyGrantPolish("/tmp/review-checkout", { id: "first", turnIds: ["first"] }, "修复按钮。", e),
  ).rejects.toThrow("not confirmed");
  expect(e.calls[0][1]).toEqual([
    "/tmp/review-checkout/scripts/dev/eval.ts",
    "edit",
    "--no-pair",
    "first",
    "修复按钮。",
  ]);
});
test("refused polish reports failure rather than pretending that raw was replaced", async () => {
  const e = executor({ type: "error", error: "not settled" }, 1);
  await expect(
    applyGrantPolish("/tmp/review-checkout", { id: "first" }, "修复按钮。", e),
  ).rejects.toThrow("raw retained");
});

test("an unavailable grant transport reports a generic error without exposing stdout", async () => {
  const spawnProcess: any = () => {
    const p = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    queueMicrotask(() => p.emit("error", Error("internal details")));
    return p;
  };
  await expect(
    applyGrantPolish("/tmp/review-checkout", { id: "a" }, "text", { spawnProcess }),
  ).rejects.toThrow("polish transport unavailable");
});
