import { expect, test } from "bun:test";
import { requestVoicePair, type VoicePairState } from "../app/(app)/dev/live-audio/voice-pair";
const base = "http://127.0.0.1:13775",
  origin = "https://li.fixture.invalid";
const id = "11111111-2222-4333-8444-555555555555",
  nonce = "a".repeat(43);
const pcm = { sampleRate: 16000, channels: 1, format: "s16le" };
const ticket = {
  version: 1,
  url: "ws://127.0.0.1:33333/stream",
  capability: "c".repeat(43),
  expiresAt: 31000,
  clientOrigin: origin,
  sourceId: "li-source",
  destinationId: "chat-selected",
  input: pcm,
  output: pcm,
  frameMs: 20,
  maxFrameBytes: 640,
  inputWindowBytes: 5120,
};
function rig(
  options: { pending?: Record<string, unknown>; statuses?: unknown[]; discovery?: unknown } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [],
    states: VoicePairState[] = [];
  const statuses = [
    ...(options.statuses ?? [
      { state: "pending" },
      {
        state: "approved",
        ticket,
        approvedChat: { title: "Selected conversation", origin: "https://chat.fixture.invalid" },
      },
    ]),
  ];
  const pending = {
    requestId: id,
    requestNonce: nonce,
    expiresAt: 121000,
    approvalUrl: base + "/audio/pair/approve?requestId=" + id,
    statusUrl: base + "/audio/pair/status",
    cancelUrl: base + "/audio/pair/cancel",
    ...options.pending,
  };
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("discovery"))
      return Response.json(
        options.discovery ?? { version: 2, requestUrl: base + "/audio/pair/request" },
      );
    if (url.endsWith("/request")) return Response.json(pending);
    if (url.endsWith("/status")) return Response.json(statuses.shift() ?? { state: "pending" });
    if (url.endsWith("/cancel")) return Response.json({ state: "cancelled" });
    throw Error("unexpected endpoint");
  }) as typeof fetch;
  const args = {
    origin,
    sourceId: "li-source",
    fetch: fetcher,
    now: () => 1000,
    pause: async () => {},
    changed(state: VoicePairState) {
      states.push(state);
    },
  };
  return { calls, states, args };
}
test("ordinary connect uses local consent and selected chat, never files or Li credentials", async () => {
  const r = rig(),
    session = requestVoicePair(r.args),
    approved = await session.ready;
  expect(r.states).toEqual(["requesting", "pending", "approved"]);
  expect(approved.chat.title).toBe("Selected conversation");
  expect(approved.ticket.destinationId).toBe("chat-selected");
  const request = r.calls.find((c) => c.url.endsWith("/request"))!;
  expect(JSON.parse(String(request.init.body))).toMatchObject({
    destinationId: null,
    sourceId: "li-source",
    frameMs: 20,
  });
  for (const call of r.calls) {
    expect(call.init.credentials).toBe("omit");
    expect(call.init.referrerPolicy).toBe("no-referrer");
    expect(call.url.includes(nonce)).toBe(false);
    expect(call.url.includes(ticket.capability)).toBe(false);
  }
  session.cancel();
  session.cancel();
  await Promise.resolve();
  expect(r.calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(1);
});
test("untrusted discovery or status endpoints never receive the request nonce", async () => {
  for (const patch of [
    { pending: { statusUrl: "http://127.0.0.1:13776/audio/pair/status" } },
    { pending: { approvalUrl: base + "/audio/pair/approve?requestId=" + id + "&extra=1" } },
    { pending: { approvalUrl: base + "/audio/pair/approve?requestId=" + id + "#fragment" } },
    {
      pending: {
        approvalUrl: "http://user:password@127.0.0.1:13775/audio/pair/approve?requestId=" + id,
      },
    },
    { pending: { approvalUrl: base + "/audio/other?requestId=" + id } },

    { discovery: { version: 2, requestUrl: "https://evil.invalid/audio/pair/request" } },
    { pending: { statusUrl: "http://127.0.0.1:13775/run" } },
    { pending: { approvalUrl: base + "/audio/pair/approve?requestNonce=" + nonce } },
  ]) {
    const r = rig(patch);
    await expect(requestVoicePair(r.args).ready).rejects.toThrow();
    expect(r.states.at(-1)).toBe("unavailable");
    expect(
      r.calls.some((c) => c.url.startsWith("https://evil.invalid") || c.url.endsWith("/run")),
    ).toBe(false);
  }
});
test("denial and expiry do not open an audio connection", async () => {
  for (const state of ["denied", "expired", "cancelled"] as const) {
    const r = rig({ statuses: [{ state }] });
    await expect(requestVoicePair(r.args).ready).rejects.toThrow(state);
    expect(r.states.at(-1)).toBe(state);
    expect(r.calls.some((c) => c.url.startsWith("ws:"))).toBe(false);
  }
});
test("wrong-origin or mismatched-source approved capabilities fail closed and revoke", async () => {
  for (const bad of [
    { ...ticket, clientOrigin: "https://other.invalid" },
    { ...ticket, sourceId: "someone-else" },
  ]) {
    const r = rig({
      statuses: [
        {
          state: "approved",
          ticket: bad,
          approvedChat: { title: "Chat", origin: "https://chat.fixture.invalid" },
        },
      ],
    });
    await expect(requestVoicePair(r.args).ready).rejects.toThrow();
    expect(r.states.at(-1)).toBe("unavailable");
    expect(r.calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(1);
  }
});
test("cancel while pending revokes once and aborts without waiting for consent", async () => {
  const r = rig(),
    wait = Promise.withResolvers<void>();
  r.args.pause = () => wait.promise;
  const session = requestVoicePair(r.args);
  while (!r.states.includes("pending") || !r.calls.some((c) => c.url.endsWith("status")))
    await new Promise((r) => setTimeout(r, 0));
  session.cancel();
  wait.resolve();
  await expect(session.ready).rejects.toThrow("cancelled");
  expect(r.states.at(-1)).toBe("cancelled");
  expect(r.calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(1);
});

test("default consent wait is immediately abortable and bounded by request expiry", async () => {
  const r = rig({ statuses: [{ state: "pending" }] });
  const session = requestVoicePair({ ...r.args, pause: undefined });
  while (!r.calls.some((c) => c.url.endsWith("status"))) await new Promise((r) => setTimeout(r, 0));
  session.cancel();
  await expect(session.ready).rejects.toThrow();
  expect(r.calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(1);
  let now = 1000;
  const expired = rig({ statuses: [{ state: "pending" }] });
  await expect(
    requestVoicePair({
      ...expired.args,
      now: () => now,
      pause: async () => {
        now += 120001;
      },
    }).ready,
  ).rejects.toThrow("expired");
  expect(expired.states.at(-1)).toBe("expired");
});
test("oversized local responses and non-loopback discovery fail without following links", async () => {
  const r = rig();
  const oversized = requestVoicePair({
    ...r.args,
    fetch: async () => new Response("x".repeat(20000)),
  });
  await expect(oversized.ready).rejects.toThrow();
  expect(r.states.at(-1)).toBe("unavailable");
  const invalid = rig();
  await expect(
    requestVoicePair({ ...invalid.args, base: "https://evil.invalid" }).ready,
  ).rejects.toThrow();
  expect(invalid.calls).toHaveLength(0);
});

test("the normal consent wait resumes on approval and failed cleanup never leaks an unhandled rejection", async () => {
  const r = rig();
  const fetcher = r.args.fetch;
  const session = requestVoicePair({
    ...r.args,
    pause: undefined,
    fetch: async (url, init) => {
      if (url.endsWith("/cancel")) throw Error("local assistant stopped");
      return fetcher(url, init);
    },
  });
  expect((await session.ready).chat.title).toBe("Selected conversation");
  session.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.states.at(-1)).toBe("cancelled");
  const broken = rig();
  await expect(
    requestVoicePair({
      ...broken.args,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error("local response interrupted"));
            },
          }),
        ),
    }).ready,
  ).rejects.toThrow();
  expect(broken.states.at(-1)).toBe("unavailable");
});

test("invalid page origins, expired approvals and malformed identities never grant a call", async () => {
  for (const origin of [
    "http://untrusted.invalid",
    "ftp://localhost",
    "https://li.fixture.invalid/path",
  ]) {
    const r = rig();
    await expect(requestVoicePair({ ...r.args, origin }).ready).rejects.toThrow();
    expect(r.calls).toHaveLength(0);
  }
  for (const pending of [
    { requestId: "invalid" },
    { requestNonce: "short" },
    { expiresAt: 999 },
    { expiresAt: 121001 },
  ]) {
    const r = rig({ pending });
    await expect(requestVoicePair(r.args).ready).rejects.toThrow();
    expect(r.states.at(-1)).toBe("unavailable");
  }
  const r = rig({
    statuses: [
      { state: "approved", ticket, approvedChat: { title: "Chat", origin: "javascript:alert(1)" } },
    ],
  });
  await expect(requestVoicePair(r.args).ready).rejects.toThrow();
  expect(r.states.at(-1)).toBe("unavailable");
});

test("a human can allow local-network access after five seconds without losing Connect", async () => {
  const r = rig();
  let now = 1000;
  const deadlines: { at: number; controller: AbortController }[] = [];
  const result = await requestVoicePair({
    ...r.args,
    now: () => now,
    deadline(ms) {
      const controller = new AbortController();
      deadlines.push({ at: now + ms, controller });
      return controller.signal;
    },
    fetch: async (url, init) => {
      if (url.endsWith("discovery")) {
        expect(deadlines.length).toBeGreaterThan(0);
        now += 6000; // Native permission dialog stays open while the human reads it.
        for (const pending of deadlines) if (pending.at <= now) pending.controller.abort();
        if (init.signal?.aborted) throw Error("permission response arrived too late");
      }
      return r.args.fetch(url, init);
    },
  }).ready;
  expect(result.chat.title).toBe("Selected conversation");
  expect(r.states.at(-1)).toBe("approved");
});
test("Cancel remains immediate while the browser waits for local-network permission", async () => {
  const r = rig();
  const session = requestVoicePair({
    ...r.args,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
      }),
  });
  session.cancel();
  await expect(session.ready).rejects.toThrow("cancelled");
  expect(r.states.at(-1)).toBe("cancelled");
  expect(r.calls).toHaveLength(0);
});
