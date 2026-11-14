import { expect, test } from "bun:test";
import { HubWork } from "@/lib/hub-work";
test("idle diagnostics create no work; settled and rejected calls leave no pending RPC", async () => {
  let now = 100;
  const hub = new HubWork(() => now);
  expect(hub.snapshot()).toMatchObject({ startedAt: 100, lastActiveAt: null, pendingRpc: 0 });
  let finish!: (value: string) => void;
  const run = hub.run(
    "polishLines",
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  expect(hub.snapshot().calls).toEqual([{ method: "polishLines", since: 100 }]);
  now = 200;
  finish("done");
  expect(await run).toBe("done");
  expect(hub.snapshot()).toMatchObject({ lastActiveAt: 200, pendingRpc: 0 });
  await expect(
    hub.run("partnerReply", async () => {
      throw Error("timeout");
    }),
  ).rejects.toThrow("timeout");
  expect(hub.snapshot().pendingRpc).toBe(0);
  const woke = new HubWork(() => 300);
  expect(woke.snapshot()).toMatchObject({ startedAt: 300, lastActiveAt: null, pendingRpc: 0 });
});
