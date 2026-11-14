import { expect, test } from "bun:test";
import { boundedSessions, untilAbort } from "@/lib/bounded-sessions";
import { HubWork } from "@/lib/hub-work";
import { CONFIG } from "@/lib/config";
import { rpcStub } from "./support/rpc-stub";
test("no work or timer until a method is called; legacy RPC mocks keep their receiver", async () => {
  const work = new HubWork();
  let timers = 0;
  const rpc = boundedSessions(
    rpcStub({ live: async (user: string) => user }),
    work,
    Date.now,
    () => {
      timers++;
      return new AbortController().signal;
    },
  );
  expect(timers).toBe(0);
  expect(work.snapshot().pendingRpc).toBe(0);
  expect(await rpc.live("fixture")).toBe("fixture");
  expect(timers).toBe(1);
  expect(work.snapshot().pendingRpc).toBe(0);
});
test("binding deadline aborts the actual transport, drops pending diagnostics, and permits retry", async () => {
  const work = new HubWork();
  const deadlines: number[] = [];
  const controllers: AbortController[] = [];
  let now = 10,
    attempts = 0,
    aborted = 0;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const raw = {
    live: async () => "unused",
    polishLines: async () => "unused",
    partnerReply: async () => "unused",
    config: async () => "unused",
    fetch: async (request: Request) => {
      const { method, args } = (await request.json()) as { method: string; args: string[] };
      if (method === "config")
        return Response.json({ value: args[0] === "chat.polishRpcTimeoutMs" ? 700 : "invalid" });
      if (method === "partnerReply") return new Response(null, { status: 503 });
      attempts++;
      started();
      if (attempts > 1) return Response.json({ value: "recovered" });
      return new Promise<Response>((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(request.signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  const rpc = boundedSessions(
    raw,
    work,
    () => now,
    (ms) => {
      deadlines.push(ms);
      const c = new AbortController();
      controllers.push(c);
      return c.signal;
    },
  );
  const pending = rpc.polishLines();
  await began;
  expect(work.snapshot().pendingRpc).toBe(1);
  expect(deadlines.at(-1)).toBe(700);
  controllers.at(-1)!.abort(Error("deadline"));
  await expect(pending).rejects.toThrow("deadline");
  expect(aborted).toBe(1);
  expect(work.snapshot().pendingRpc).toBe(0);
  expect(await rpc.polishLines()).toBe("recovered");
  await expect(rpc.partnerReply()).rejects.toThrow("sessions partnerReply: 503");
  expect(deadlines.at(-1)).toBe(CONFIG["chat.partnerRpcTimeoutMs"].default);
  now += 61_000;
  expect(await rpc.live()).toBe("recovered");
  expect(work.snapshot().pendingRpc).toBe(0);
});
test("rejected config reads fall back, concurrent refresh is shared, abort before start does no work", async () => {
  let reads = 0,
    ran = false;
  const work = new HubWork();
  const raw = {
    live: async (): Promise<unknown> => null,
    config: async () => null,
    fetch: async (request: Request) => {
      const b = (await request.json()) as { method: string };
      if (b.method === "config") {
        reads++;
        throw Error("offline");
      }
      return Response.json({ value: "live" });
    },
  };
  const rpc = boundedSessions(raw, work);
  expect(await Promise.all([rpc.live(), rpc.live()])).toEqual(["live", "live"]);
  expect(reads).toBe(3);
  const c = new AbortController();
  c.abort(Error("already aborted"));
  await expect(
    untilAbort(c.signal, async () => {
      ran = true;
    }),
  ).rejects.toThrow("already aborted");
  expect(ran).toBe(false);
  expect(work.snapshot().pendingRpc).toBe(0);
});
