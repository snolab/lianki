import { describe, expect, test } from "bun:test";
import { pendingBubble, planPendingSend } from "../packages/debug-chat/src/pending-bubble";
import type { PendingFile } from "../packages/debug-chat/src/files";

const file = (extra: Partial<PendingFile> = {}): PendingFile => ({
  key: "f1",
  name: "one.png",
  type: "image/png",
  size: 10,
  sent: 0,
  state: "uploading",
  ...extra,
});
const done = (id: string, name = `${id}.png`): PendingFile =>
  file({ key: id, name, state: "done", ref: { id, name, type: "image/png", size: 10 } });
const candidate = { selection: "Selected words", path: "/words", title: "Words" };

describe("one pending attachment bubble", () => {
  test("aggregates byte progress without depending on completion order", () => {
    expect(pendingBubble([])).toMatchObject({
      state: "empty",
      sent: 0,
      total: 0,
      progress: 0,
      refs: [],
    });
    expect(
      pendingBubble([file({ sent: 4 }), file({ key: "f2", size: 30, sent: 10 })]),
    ).toMatchObject({ state: "uploading", sent: 14, total: 40, progress: 0.35 });
    expect(pendingBubble([file({ sent: 50 }), file({ sent: -1 })])).toMatchObject({
      sent: 10,
      total: 20,
      progress: 0.5,
    });
    expect(pendingBubble([done("first"), done("second")])).toMatchObject({
      state: "ready",
      sent: 20,
      progress: 1,
    });
    expect(pendingBubble([done("first"), done("second")]).refs.map((r) => r.id)).toEqual([
      "first",
      "second",
    ]);
    expect(
      pendingBubble([
        file({
          state: "done",
          size: 0,
          ref: { id: "zero", name: "zero", type: "text/plain", size: 0 },
        }),
      ]).progress,
    ).toBe(1);
    expect(pendingBubble([file({ size: 0 })]).progress).toBe(0);
    expect(pendingBubble([file({ state: "done" })]).state).toBe("uploading");
  });

  test("failed or oversized files stall the entire bubble, preserving successful files", () => {
    for (const state of ["failed", "too-big", "uploading"] as const) {
      const files = [done("first"), file({ key: "second", state })];
      const before = structuredClone(files);
      expect(planPendingSend({ text: "typed", files, candidate })).toBeNull();
      expect(files).toEqual(before);
    }
    expect(pendingBubble([done("first"), file({ state: "failed" })]).state).toBe("failed");
    expect(pendingBubble([file({ state: "too-big" })]).state).toBe("failed");
  });

  test("selection alone does not send; its tap or other actual input attaches the quote", () => {
    expect(planPendingSend({ text: "", files: [], candidate })).toBeNull();
    expect(planPendingSend({ text: " ", files: [], candidate })).toBeNull();
    expect(planPendingSend({ text: "", files: [], candidateTapped: true })).toBeNull();
    expect(planPendingSend({ text: "", files: [], candidate, candidateTapped: true })).toEqual({
      text: "Selected words",
      attachments: [],
      context: candidate,
    });
    for (const text of ["typed words", "spoken words"])
      expect(planPendingSend({ text, files: [], candidate })).toEqual({
        text,
        attachments: [],
        context: candidate,
      });
    expect(planPendingSend({ text: "", files: [done("screenshot")], candidate })).toEqual({
      text: "screenshot.png",
      attachments: [done("screenshot").ref!],
      context: candidate,
    });
    expect(planPendingSend({ text: "", files: [done("first"), done("second")] })?.text).toBe(
      "first.png, second.png",
    );
  });

  test("explicitly attached context wins and snapshots cannot mutate pending metadata", () => {
    const attached = { selection: "Pinned selection", path: "/reader" };
    const files = [done("one")];
    const plan = planPendingSend({ text: " text ", files, candidate, attached })!;
    expect(plan.text).toBe("text");
    expect(plan.context).toEqual(attached);
    plan.context!.selection = "render mutation";
    plan.attachments[0]!.name = "render mutation";
    expect(attached.selection).toBe("Pinned selection");
    expect(files[0]!.ref!.name).toBe("one.png");
    expect(
      planPendingSend({ text: "x", files: [], attached: { selection: "" }, candidate })?.context,
    ).toEqual(candidate);
    expect(planPendingSend({ text: "x", files: [] })).toEqual({ text: "x", attachments: [] });
  });
});
