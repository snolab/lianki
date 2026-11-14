import { expect, test } from "bun:test";
import { createPttSubmission, type PttPreview } from "../packages/debug-chat/src/ptt-submission";

type Line = { text: string; recheck?: { heard: string; text: string } };
function fixture() {
  let scope = "a";
  let accepts = false;
  const attempts: Line[] = [];
  let shown: PttPreview | null = null;
  const q = createPttSubmission<Line>({
    scope: () => scope,
    show: (value) => {
      shown = value;
    },
    send: (line) => {
      attempts.push(structuredClone(line));
      return accepts;
    },
  });
  return {
    q,
    attempts,
    shown: () => shown,
    scope: (value: string) => {
      scope = value;
    },
    accept: () => {
      accepts = true;
    },
  };
}

test("held realtime and exact release boundaries remain visible until durable acceptance", () => {
  const h = fixture();
  const key = h.q.begin(100)!;
  h.q.partial(key, "Real time.");
  expect(h.shown()).toBeNull();
  h.q.hold(key);
  expect(h.shown()).toMatchObject({ text: "Real time.", state: "speaking", start: 100 });
  h.q.release(key, 400);
  expect(h.shown()).toMatchObject({ text: "Real time.", state: "sending", start: 100, end: 400 });
  expect(
    h.q.complete(key, {
      text: "Real time.",
      recheck: { heard: "Real time.", text: "Whole recording." },
    }),
  ).toBe(false);
  expect(h.shown()).toMatchObject({ text: "Real time.", state: "unsent" });
  expect(h.q.begin(500)).toBeNull();
  h.accept();
  expect(h.q.retry()).toBe(true);
  expect(h.shown()).toBeNull();
  expect(h.attempts).toEqual([
    { text: "Real time.", recheck: { heard: "Real time.", text: "Whole recording." } },
    { text: "Real time.", recheck: { heard: "Real time.", text: "Whole recording." } },
  ]);
  expect(h.q.retry()).toBe(false);
});

test("account change and explicit cancellation ignore all late partials and completions", () => {
  const h = fixture();
  const key = h.q.begin(100)!;
  h.q.hold(key);
  h.scope("b");
  h.q.partial(key, "private");
  expect(h.q.complete(key, { text: "private" })).toBe(false);
  expect(h.attempts).toEqual([]);
  h.q.cancel();
  const next = h.q.begin(200)!;
  h.q.hold(next);
  h.q.cancel();
  h.q.partial(next, "late");
  expect(h.q.complete(next, { text: "late" })).toBe(false);
  expect(h.shown()).toBeNull();
});

test("an explicit recognition cap preserves partial text and reason without submitting a truncated result", () => {
  const h = fixture();
  const key = h.q.begin(10)!;
  h.q.hold(key);
  h.q.partial(key, "Observed words");
  h.q.failed(key, "Recording limit reached");
  expect(h.shown()).toMatchObject({
    text: "Observed words",
    state: "unsent",
    reason: "Recording limit reached",
  });
  expect(h.q.ready()).toBe(false);
  expect(h.q.busy()).toBe(false);
  expect(h.q.retry()).toBe(false);
  expect(h.attempts).toEqual([]);
  expect(h.q.begin(50)).not.toBeNull(); // The failed text is now recoverable in the normal draft.
});
