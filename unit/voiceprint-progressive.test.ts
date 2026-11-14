import { expect, it } from "bun:test";
import { createEnrolment, type EnrolDeps } from "@lianki/debug-chat/voiceprint";

function setup() {
  let on = false;
  let denied = false;
  const calls: Record<string, unknown>[] = [];
  const approvals: string[] = [];
  const d: EnrolDeps = {
    device: "phone",
    capture: () => {},
    ticket: async (op, device) => {
      approvals.push(`${op}:${device}`);
      if (denied && op === "progressive") throw new Error("passkey cancelled");
      return `${op}-ticket`;
    },
    request: async (m) => {
      calls.push(m);
      if (m.op === "progressive") on = m.on === true;
      return {
        ok: true,
        progressive: { on },
        prints: [{ device: "phone", model: "campp", n: 12, enrolN: 10, progN: 2 }],
      };
    },
  };
  return {
    c: createEnrolment(d, () => {}),
    calls,
    approvals,
    deny: () => {
      denied = true;
    },
  };
}

it("loads confirmed learning state and counts, changes both ways with a wildcard passkey ticket", async () => {
  const { c, calls, approvals } = setup();
  await c.open();
  expect(c.view()).toMatchObject({
    step: "status",
    progressive: { on: false },
    prints: [{ enrolN: 10, progN: 2 }],
  });
  const first = c.progressive(true);
  await c.progressive(false); // The pending approval cannot be duplicated.
  await first;
  expect(c.view()).toMatchObject({ progressive: { on: true } });
  expect(calls.filter((m) => m.op === "progressive")).toEqual([
    { t: "voiceprint", op: "progressive", on: true, ticket: "progressive-ticket" },
  ]);
  expect(approvals).toContain("progressive:*");
  await c.progressive(false);
  expect(c.view()).toMatchObject({ progressive: { on: false } });
});

it("keeps the confirmed state and exposes a cancelled passkey; closing prevents a pending mutation", async () => {
  const { c, calls, deny } = setup();
  await c.open();
  deny();
  await c.progressive(true);
  expect(c.view()).toMatchObject({
    progressive: { on: false },
    progressiveError: "passkey cancelled",
  });
  expect(calls.some((m) => m.op === "progressive")).toBe(false);
  const s = setup();
  await s.c.open();
  const pending = s.c.progressive(true);
  s.c.close();
  await pending;
  expect(s.c.view()).toEqual({ step: "closed" });
  expect(s.calls.some((m) => m.op === "progressive")).toBe(false);
});
