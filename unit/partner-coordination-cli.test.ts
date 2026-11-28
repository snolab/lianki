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
  makeSeqCursor,
  refreshAdvisoryLines,
  SEND_MAX_CHARS,
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
  await delivery.settled();
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
  await delivery.settled();
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

test("a target becoming busy during the advisory read requires another live read before delivery", async () => {
  let busy = false;
  let on = true;
  let reads = 0;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sent: string[] = [];
  const skipped: string[] = [];
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => busy,
    undefined,
    5,
    undefined,
    async (lines) => {
      reads++;
      const result = refreshAdvisoryLines(lines, snapshot({ partnerStandardFlow: on }));
      if (reads === 1) {
        busy = true;
        started();
      }
      return result;
    },
    (lines) => skipped.push(...lines.map((l) => l.id)),
  );
  try {
    await delivery.add(lineOf(JSON.stringify(event(notice())))!);
    await reading;
    await delivery.add({ id: "urgent-raw", from: "owner", thread: "owner", text: "@coco next" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("urgent-raw");
    expect(sent[0]).not.toContain("Learning Partner context update");
  } finally {
    on = false;
    busy = false;
    await delivery.settled();
  }
  expect(reads).toBe(2);
  expect(skipped).toEqual(["brief-1"]);
  expect(sent).toHaveLength(1);
});

test("each advisory transport part rereads the switch after the previous part was handed over", async () => {
  let busy = true;
  let on = true;
  let reads = 0;
  const first = notice({
    text: "a".repeat(1600),
    coordination: { ...notice().coordination, summary: "s".repeat(20000) },
  });
  const second = notice({ id: "brief-2", seq: 3, text: "b".repeat(620) });
  const sent: string[] = [];
  const skipped: string[] = [];
  const delivered: string[] = [];
  const cursor = makeSeqCursor(0);
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      if (body.length > SEND_MAX_CHARS) return 1;
      if (body.includes("brief-1")) on = false;
      return 0;
    },
    async () => busy,
    undefined,
    5,
    (lines, ok) => {
      if (ok) {
        delivered.push(...lines.map((line) => line.id));
        cursor.release(lines.map((line) => line.seq));
      }
    },
    async (lines) => {
      reads++;
      return refreshAdvisoryLines(
        lines,
        snapshot({ partnerStandardFlow: on, messages: [snapshot().messages[0], first, second] }),
      );
    },
    (lines) => {
      skipped.push(...lines.map((l) => l.id));
      cursor.release(lines.map((line) => line.seq));
    },
  );
  cursor.hold(2);
  cursor.hold(3);
  await delivery.add(lineOf(JSON.stringify(event(first)))!);
  await delivery.add(lineOf(JSON.stringify(event(second)))!);
  busy = false;
  cursor.hold(4);
  await delivery.add(
    lineOf(
      JSON.stringify(
        event({
          id: "ordinary-context",
          from: "agent",
          label: "Helper",
          thread: "owner",
          text: "FYI",
          seq: 4,
        }),
      ),
    )!,
  );
  await delivery.settled();
  expect(reads).toBe(2);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("ordinary-context");
  expect(sent[1]).toContain("brief-1");
  expect(sent[1]).toContain("Original ids: raw-1");
  expect(sent[1]).toContain("advisory, not a new instruction or permission");
  expect(sent.every((body) => body.length <= SEND_MAX_CHARS)).toBe(true);
  expect(sent.some((body) => body.includes("brief-2"))).toBe(false);
  expect(skipped).toEqual(["brief-2"]);
  expect(delivery.pending()).toBe(0);
  expect(delivered).toEqual(["ordinary-context", "brief-1"]);
  expect(cursor.value()).toBe(4);
});

test("a bounded advisory rejected by transport stays held, without a delivery receipt", async () => {
  const cursor = makeSeqCursor(0);
  cursor.hold(2);
  const outcomes: boolean[] = [];
  const sizes: number[] = [];
  const text = "x".repeat(2000);
  const message = notice({ text });
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sizes.push(body.length);
      return 1;
    },
    async () => false,
    undefined,
    undefined,
    (lines, ok) => {
      outcomes.push(ok);
      if (ok) cursor.release(lines.map((l) => l.seq));
    },
    async (lines) =>
      refreshAdvisoryLines(lines, snapshot({ messages: [snapshot().messages[0], message] })),
    () => {
      throw Error("A transport failure must not discard the notice");
    },
  );
  await delivery.add(lineOf(JSON.stringify(event(message)))!);
  await delivery.settled();
  expect(sizes).toHaveLength(1);
  expect(sizes[0]).toBeLessThanOrEqual(SEND_MAX_CHARS);
  expect(outcomes).toEqual([false]);
  expect(cursor.value()).toBeLessThan(2);
});

test("the serial live reader hands off later raw input while an earlier notice read is pending", async () => {
  const cursor = makeSeqCursor(0);
  const sent: string[] = [];
  const skipped: string[] = [];
  let finish!: () => void;
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => false,
    undefined,
    undefined,
    (lines, ok) => {
      if (ok) cursor.release(lines.map((l) => l.seq));
    },
    async (lines) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return refreshAdvisoryLines(lines, snapshot({ partnerStandardFlow: false }));
    },
    (lines) => {
      skipped.push(...lines.map((l) => l.id));
      cursor.release(lines.map((l) => l.seq));
    },
  );
  // Match the production stdout loop: each handle is awaited before reading
  // the next event, rather than starting concurrent add calls in the test.
  for (const message of [
    notice(),
    { id: "later-raw", from: "owner", thread: "owner", text: "@coco next", seq: 3 },
  ]) {
    const line = lineOf(JSON.stringify(event(message)))!;
    cursor.hold(line.seq);
    await delivery.add(line);
  }
  expect(typeof finish).toBe("function");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("later-raw");
  expect(cursor.value()).toBeLessThan(3);
  expect(delivery.pending()).toBe(1);
  finish();
  await delivery.settled();
  expect(skipped).toEqual(["brief-1"]);
  expect(cursor.value()).toBe(3);
  expect(delivery.pending()).toBe(0);
});

test("independent advisory checks preserve notice order", async () => {
  const checked: string[] = [];
  const sent: string[] = [];
  let finish!: () => void;
  const delivery = makeDeliverer(
    { lane: "codex", repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => false,
    undefined,
    undefined,
    undefined,
    async (lines) => {
      checked.push(lines[0].id);
      if (lines[0].id === "brief-1")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return lines;
    },
  );
  await delivery.add(lineOf(JSON.stringify(event(notice())))!);
  await delivery.add(lineOf(JSON.stringify(event(notice({ id: "brief-2", seq: 4 }))))!);
  expect(checked).toEqual(["brief-1"]);
  expect(sent).toEqual([]);
  finish();
  await delivery.settled();
  expect(checked).toEqual(["brief-1", "brief-2"]);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("brief-1");
  expect(sent[1]).toContain("brief-2");
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
