import { expect, test } from "bun:test";
import { createChatBridge } from "../packages/lianki-cli/chat-bridge.mjs";
import { createChatReceiver } from "../packages/lianki-cli/chat-receiver.mjs";

const voice = (id: string, text: string, extra = {}) => ({
  type: "chat",
  message: { id, text, from: "owner", thread: "owner", source: "stt", ...extra },
});
function setup(prepare?: (input: any) => Promise<any>) {
  const sent: any[] = [];
  const bridge = createChatBridge({
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  const r = createChatReceiver({ bridge, prepare, requestId: () => "test-request" });
  return { r, sent };
}
test("continuous voice and edits assemble one authoritative raw turn with every revision", async () => {
  const calls: any[] = [];
  const { r, sent } = setup(async (input) => {
    calls.push(input);
    return {
      action: "forward",
      turn: "complete",
      polished: "Please fix the button, keeping it blue.",
    };
  });
  await r.accept(voice("a", "please fix"));
  await r.accept({ type: "edited", id: "a", text: "please fix the button" });
  await r.accept(voice("b", "keep it blue"));
  expect(sent).toHaveLength(0);
  await r.finish();
  expect(sent).toHaveLength(1);
  expect(sent[0].message.text).toBe("please fix the button\nkeep it blue");
  expect(sent[0].message.rawRevisions.map((x: any) => x.text)).toEqual([
    "please fix",
    "please fix the button",
    "keep it blue",
  ]);
  expect(sent[0].message.polished).toContain("Please fix");
  expect(calls).toHaveLength(1);
});
test("clear household turns never reach the heavy assistant", async () => {
  const { r, sent } = setup(async () => ({
    action: "ignore",
    confidence: "high",
    reason: "household",
    turn: "complete",
  }));
  await r.accept(voice("a", "宝宝过来"));
  await r.accept(voice("b", "饭好了"));
  await r.finish();
  expect(sent).toHaveLength(0);
});
test("cancellation is immediate and invalidates a pending light-model response", async () => {
  let resolve!: (v: any) => void;
  const { r, sent } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await r.accept(voice("a", "please change"));
  const pending = r.finish();
  await r.accept(voice("stop", "停止。"));
  expect(sent).toHaveLength(1);
  expect(sent[0].message.text).toBe("停止。");
  resolve({ action: "forward", turn: "complete" });
  await pending;
  expect(sent).toHaveLength(1);
});
test("an assistant reply is a hard boundary, even while preparation is in flight", async () => {
  const { r, sent } = setup();
  await r.accept(voice("a", "first request"));
  const reply = r.accept(voice("reply", "working", { from: "agent" }));
  const next = r.accept(voice("b", "second request"));
  await Promise.all([reply, next]);
  await r.finish();
  expect(sent.map((x) => x.message.text)).toEqual(["first request", "second request"]);
});
test("missing inference still assembles a bounded raw turn", async () => {
  const { r, sent } = setup(async () => {
    throw Error("unavailable");
  });
  await r.accept(voice("a", "please fix"));
  await r.accept(voice("b", "the button"));
  await r.finish();
  expect(sent).toHaveLength(1);
  expect(sent[0].message.text).toBe("please fix\nthe button");
});
test("continue waits for the bounded deadline then sends once without another model call", async () => {
  const sent: any[] = [];
  let calls = 0;
  const r = createChatReceiver({
    bridge: { accept: async (e: any) => sent.push(e) },
    requestId: () => "test",
    config: { quietMs: 1, maxWaitMs: 8 },
    prepare: async () => {
      calls++;
      return { action: "forward", turn: "continue" };
    },
  });
  await r.accept(voice("a", "please fix the"));
  await new Promise((done) => setTimeout(done, 20));
  await r.finish();
  expect(sent).toHaveLength(1);
  expect(calls).toBe(1);
});

test("slow UI polish never delays a complete raw instruction or loses it when new speech arrives", async () => {
  const sent: any[] = [];
  let polishStarted = false;
  const r = createChatReceiver({
    bridge: createChatBridge({
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    }),
    requestId: () => "synthetic",
    prepare: async (input) => ({
      action: "forward",
      turn: "complete",
      polished: input.text + "。",
    }),
    polish: async () => {
      polishStarted = true;
      return new Promise(() => {});
    },
  });
  await r.accept(voice("a", "不要删除按钮"));
  await r.finish();
  expect(polishStarted).toBe(true);
  expect(sent.map((x) => x.message.text)).toEqual(["不要删除按钮"]);
  await r.accept(voice("b", "再把颜色改蓝"));
  await r.finish();
  expect(sent.map((x) => x.message.text)).toEqual(["不要删除按钮", "再把颜色改蓝"]);
  r.stop();
});

test("self-polish broadcast before ack and undo events do not awaken another task", async () => {
  const sent: any[] = [];
  let r: any;
  r = createChatReceiver({
    bridge: createChatBridge({
      deliver: async (s: string) => {
        sent.push(JSON.parse(s));
      },
    }),
    requestId: () => "synthetic",
    prepare: async () => ({ action: "forward", turn: "complete", polished: "修复按钮。" }),
    polish: async () => {
      await r.accept({ type: "edited", id: "a", text: "修复按钮。" });
    },
  });
  await r.accept(voice("a", "修复按钮"));
  await r.finish();
  await r.accept({ type: "edited", id: "a", text: "修复按钮。" });
  await r.accept({
    type: "edited",
    id: "a",
    text: "修复按钮",
    restored: [{ id: "a", text: "修复按钮" }],
  });
  await r.finish();
  expect(sent).toHaveLength(1);
});

test("the supplied synthetic request fragments each form a single run and keep CLI words", async () => {
  for (const parts of [
    ["前置一个deepseek用", "cloudflare的ai", "去过滤", "无关消息", "并且", "实时回复我"],
    ["可以是lianki chat", "listen/", "send/", "read", "等等"],
  ]) {
    const { r, sent } = setup();
    for (const [i, text] of parts.entries()) await r.accept(voice(String(i), text));
    await r.finish();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.text).toBe(parts.join("\n"));
    expect(sent[0].message.rawRevisions).toHaveLength(parts.length);
  }
});

test("natural Chinese cancellation phrases immediately discard the buffered run", async () => {
  for (const phrase of ["停止那个任务", "先停一下", "请取消刚才的操作", "Codex，停止那个任务"]) {
    const { r, sent } = setup();
    await r.accept(voice("a", "做一个设置按钮"));
    await r.accept(voice("stop", phrase));
    expect(sent).toHaveLength(1);
    expect(sent[0].message.text).toBe(phrase);
    await r.finish();
    expect(sent).toHaveLength(1);
  }
});

test("undo removes only its affected buffered message and never discards an independent request", async () => {
  const { r, sent } = setup();
  await r.accept(voice("a", "old merged request"));
  await r.accept(voice("b", "independent new request"));
  await r.accept({ type: "edited", id: "a", text: "old", split: [{ id: "a", text: "old" }] });
  await r.finish();
  expect(sent.map((x) => x.message.text)).toEqual(["independent new request"]);
});

test("UI refusal is diagnostic only and raw still dispatches once", async () => {
  const sent: any[] = [];
  const reports: any[] = [];
  const r = createChatReceiver({
    bridge: { accept: async (e: any) => sent.push(e) },
    requestId: () => "test",
    prepare: async () => ({ action: "forward", polished: "fix it." }),
    polish: async () => {
      throw Error("not settled");
    },
    report: (e) => reports.push(e),
  });
  await r.accept(voice("a", "fix it"));
  await r.finish();
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(reports.some((x) => x.type === "polish-refused")).toBe(true);
});

test("a timer delivery error reaches the receiver error callback", async () => {
  const errors: any[] = [];
  const r = createChatReceiver({
    bridge: {
      accept: async () => {
        throw Error("unavailable");
      },
    },
    requestId: () => "test",
    config: { quietMs: 1, maxWaitMs: 3 },
    onError: (e) => errors.push(e),
  });
  await r.accept(voice("a", "fix it"));
  await new Promise((done) => setTimeout(done, 10));
  r.stop();
  expect(errors[0]?.message).toBe("unavailable");
});
