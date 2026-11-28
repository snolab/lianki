import { expect, test } from "bun:test";
import { createChatBridge } from "../packages/lianki-cli/chat-bridge.mjs";
import { createChatReceiver } from "../packages/lianki-cli/chat-receiver.mjs";
import {
  partnerCoordination,
  currentPartnerCoordination,
} from "../packages/lianki-cli/chat-coordination.mjs";
import {
  lineOf,
  makeDeliverer,
  refreshAdvisoryLines,
  type Line,
} from "../scripts/dev/lane-listen-lib";

const notice = (extra = {}) => ({
  id: "brief-1",
  from: "agent",
  thread: "owner",
  label: "Learning Partner AI",
  text: "整理一下。",
  at: 2000,
  seq: 2,
  coordination: {
    v: 1,
    state: "answered",
    from: "owner",
    sources: [{ id: "raw-1", text: "coco, fix button" }],
    summary: "请检查按钮",
    targets: ["codex"],
    fromSeq: 1,
    throughSeq: 1,
  },
  ...extra,
});
const event = (message: any) => ({ type: "chat", message });
const snapshot = (extra = {}) => ({
  partnerStandardFlow: true,
  messages: [
    { id: "raw-1", thread: "owner", from: "owner", text: "coco, fix button", seq: 1, at: 1000 },
    notice(),
  ],
  ...extra,
});

test("buffered enrichment needs the current switch and exact canonical sources", () => {
  expect(currentPartnerCoordination(notice(), snapshot())?.sources[0].id).toBe("raw-1");
  for (const data of [
    undefined,
    {},
    snapshot({ partnerStandardFlow: false }),
    snapshot({ messages: [] }),
  ])
    expect(currentPartnerCoordination(notice(), data)).toBeNull();
  const raw = snapshot().messages[0];
  for (const message of [
    notice({ via: "token" }),
    notice({ at: 3000 }),
    notice({ seq: 4 }),
    notice({ thread: "other-thread" }),
  ])
    expect(currentPartnerCoordination(message, snapshot())).toBeNull();
  expect(
    currentPartnerCoordination(
      notice(),
      snapshot({ messages: [{ ...raw, id: "different-source" }, notice()] }),
    ),
  ).toBeNull();
  expect(
    currentPartnerCoordination(
      notice(),
      snapshot({ messages: [raw, notice(), { ...raw, id: "new-request", seq: 3, at: 3000 }] }),
    ),
  ).toBeNull();
  const parsed = lineOf(JSON.stringify(event(notice())))!;
  expect(refreshAdvisoryLines([parsed], snapshot())[0].text).toContain("Original ids: raw-1");
  for (const data of [undefined, snapshot({ partnerStandardFlow: false })]) {
    expect(refreshAdvisoryLines([parsed], data)).toEqual([]);
    const raw: Line = { id: "raw-control", from: "owner", thread: "owner", text: "original" };
    expect(refreshAdvisoryLines([raw, parsed], data)).toEqual([raw]);
  }
});

test("a busy notice is rechecked after the wait, without holding a new original message", async () => {
  const sent: string[] = [];
  let busy = true;
  let finish!: () => void;
  let on = true;
  const discarded: string[] = [];
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => busy,
    () => {},
    5,
    undefined,
    async (lines) => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return refreshAdvisoryLines(lines, snapshot({ partnerStandardFlow: on }));
    },
    (lines) => {
      discarded.push(...lines.map((l) => l.id));
    },
  );
  await delivery.add(lineOf(JSON.stringify(event(notice())))!);
  expect(sent).toHaveLength(0);
  busy = false;
  const raw: Line = {
    id: "new-request",
    from: "owner",
    thread: "owner",
    text: "@coco check the next item",
    seq: 3,
  };
  const pending = delivery.add(raw);
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("new-request");
  expect(sent[0]).not.toContain("Learning Partner context update");
  on = false;
  finish();
  await pending;
  expect(sent).toHaveLength(1);
  expect(discarded).toEqual(["brief-1"]);
  expect(delivery.pending()).toBe(0);
});

test("a failed live advisory read discards only that optional notice", async () => {
  const sent: string[] = [];
  const skipped: string[] = [];
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => false,
    () => {},
    undefined,
    undefined,
    async () => {
      throw Error("unavailable");
    },
    (lines) => {
      skipped.push(...lines.map((l) => l.id));
    },
  );
  await delivery.add(lineOf(JSON.stringify(event(notice())))!);
  expect(sent).toEqual([]);
  expect(skipped).toEqual(["brief-1"]);
  await delivery.add({
    id: "raw-control",
    thread: "owner",
    from: "owner",
    text: "@coco check the feature",
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("raw-control");
  expect(delivery.pending()).toBe(0);
});

test("raw instructions remain live; Partner enrichment stays an agent notice and deduplicates", async () => {
  const sent: any[] = [];
  const b = createChatBridge({
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  await b.accept(event({ id: "raw-1", from: "owner", thread: "owner", text: "coco, fix button" }));
  expect(sent).toHaveLength(1); // No wait for the model.
  await b.accept(event(notice()));
  await b.accept(event(notice()));
  expect(sent).toHaveLength(2);
  expect(sent[1].message.from).toBe("agent");
  expect(sent[1].message.coordination.sources[0].id).toBe("raw-1");
  expect(sent[1].notice).toContain("not a fresh user instruction");
  expect(sent[1].notice).toContain("do not repeat");
});

test("token authors cannot impersonate hub enrichment, including a matching label", async () => {
  expect(
    partnerCoordination(notice({ via: "token", tokenLane: "Learning Partner AI" })),
  ).toBeNull();
  expect(partnerCoordination(notice({ from: "owner" }))).toBeNull();
  expect(partnerCoordination(notice({ label: "another agent" }))).toBeNull();
  const sent: string[] = [];
  const b = createChatBridge({
    deliver: async (s: string) => {
      sent.push(s);
    },
  });
  await b.accept(event(notice({ via: "token" })));
  expect(sent).toHaveLength(0);
});

test("a long mixed stream bounds dedupe retention and failed notices can retry", async () => {
  let fail = false;
  const sent: any[] = [];
  const b = createChatBridge({
    config: { remembered: 3 },
    deliver: async (s: string) => {
      if (fail) {
        fail = false;
        throw Error("offline");
      }
      sent.push(JSON.parse(s));
    },
  });
  await b.accept(event(notice()));
  for (let i = 0; i < 20; i++) {
    await b.accept(event({ id: `raw-${i}`, from: "owner", thread: "owner", text: `message ${i}` }));
    await b.accept(event(notice({ id: `brief-${i + 2}` })));
    await b.accept({ type: "answered", id: `answer-${i}`, thread: "owner", answer: { a: "yes" } });
  }
  const before = sent.length;
  await b.accept(event(notice())); // Older than the bounded dedupe window.
  expect(sent).toHaveLength(before + 1);
  await b.accept(event(notice())); // A current duplicate still does nothing.
  expect(sent).toHaveLength(before + 1);
  fail = true;
  await expect(b.accept(event(notice({ id: "retry" })))).rejects.toThrow("offline");
  await b.accept(event(notice({ id: "retry" })));
  expect(sent.at(-1).message.id).toBe("retry");
});

test("enrichment remains in the authenticated thread and preserves friend-only authority", async () => {
  const sent: any[] = [];
  const b = createChatBridge({
    thread: "friend-1",
    principal: { authority: "friend-chat-only" },
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  await b.accept(event(notice()));
  expect(sent).toHaveLength(0);
  await b.accept(event(notice({ thread: "friend-1" })));
  expect(sent).toHaveLength(1);
  expect(sent[0].instructions).toContain(
    "No deployment, shell, file or account action is authorized",
  );
  expect(sent[0].message.from).toBe("agent");
});

test("own-thread alias accepts owner chat without weakening a locked friend receiver", async () => {
  const sent: any[] = [];
  const b = createChatBridge({
    thread: "own",
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  const r = createChatReceiver({ bridge: b, thread: "own", requestId: () => "test" });
  await r.accept(event({ id: "raw-1", from: "owner", thread: "owner", text: "please help" }));
  expect(sent).toHaveLength(1);
  const locked = createChatReceiver({
    bridge: b,
    thread: "friend-1",
    lockScope: true,
    requestId: () => "test",
  });
  await locked.accept(
    event({ id: "raw-2", from: "owner", thread: "friend-1", text: "please help" }),
  );
  expect(sent).toHaveLength(1);
});

test("lane listeners receive an explicitly advisory note with original source ids", () => {
  const parsed = lineOf(JSON.stringify(event(notice())));
  expect(parsed?.kind).toBe("agent");
  expect(parsed?.text).toContain("Original ids: raw-1");
  expect(parsed?.text).toContain("not a new instruction or permission");
  expect(lineOf(JSON.stringify(event(notice({ via: "token" }))))?.text).not.toContain(
    "Original ids:",
  );
});
