import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createFriendInbox } from "../packages/lianki-cli/chat-inbox.mjs";
import { createChatReceiver } from "../packages/lianki-cli/chat-receiver.mjs";
import { createChatBridge } from "../packages/lianki-cli/chat-bridge.mjs";
import { run } from "../packages/lianki-cli/cli.mjs";

const message = (thread: string, id: string, text: string, from = "friend") => ({
  type: "chat",
  message: { thread, id, text, from, source: "stt" },
});
test("friends retain independent assembly, duplicate IDs, context and reply destinations", async () => {
  const sent: any[] = [];
  const prepared: { thread: string; input: any }[] = [];
  const inbox = createFriendInbox({
    createReceiver: (thread) =>
      createChatReceiver({
        thread,
        requestId: () => "test",
        prepare: async (input) => {
          prepared.push({ thread, input });
          return { action: "forward", turn: "complete" };
        },
        bridge: createChatBridge({
          thread,
          deliver: async (s: string) => {
            sent.push(JSON.parse(s));
          },
          replyCommand: () => ["grant-reply", thread, "<reply>"],
        }),
      }),
  });
  await inbox.accept(message("friendA", "same-id", "A private words"));
  await inbox.accept(message("friendB", "same-id", "B private words"));
  await inbox.accept(message("friendA", "second", "A continuation"));
  await inbox.accept(message("owner", "owner-id", "owner command", "owner"));
  await inbox.accept(message("friendA", "admin-id", "owner comment", "owner"));
  await inbox.finish();
  expect(sent).toHaveLength(2);
  expect(sent.find((x) => x.message.thread === "friendA").message.text).toBe(
    "A private words\nA continuation",
  );
  expect(sent.find((x) => x.message.thread === "friendB").reply.command).toEqual([
    "grant-reply",
    "friendB",
    "<reply>",
  ]);
  expect(prepared.find((x) => x.thread === "friendA")?.input.text).not.toContain("B private");
  expect(JSON.stringify(prepared.find((x) => x.thread === "friendB")?.input)).not.toContain(
    "A private",
  );
});
test("assistant lines are context only, history never dispatches and invalid threads are refused", async () => {
  const events: any[] = [];
  const inbox = createFriendInbox({
    createReceiver: (thread) => ({
      accept: async (e: any) => events.push({ thread, event: e }),
      pending: () => false,
      finish: async () => {},
      stop: () => {},
    }),
  });
  await inbox.accept({
    type: "history",
    messages: [
      message("friendA", "old", "old").message,
      message("owner", "owner", "secret", "owner").message,
    ],
  });
  await inbox.accept(message("friendA", "reply", "answer", "agent"));
  await inbox.accept(message("../owner", "bad", "bad"));
  await inbox.finish();
  expect(events).toHaveLength(2);
  expect(events[0].event.type).toBe("history");
  expect(events[0].event.messages).toHaveLength(1);
  expect(events[1].event.message.from).toBe("agent");
});
test("inbox capacity is bounded; only idle expired threads may be released", async () => {
  let now = 0;
  let pending = true;
  let stopped = 0;
  const inbox = createFriendInbox({
    config: { maxThreads: 1, idleTtlMs: 5 },
    now: () => now,
    createReceiver: () => ({
      accept: async () => {},
      pending: () => pending,
      finish: async () => {},
      stop: () => {
        stopped++;
      },
    }),
  });
  await inbox.accept(message("friendA", "a", "hello"));
  now = 10;
  await expect(inbox.accept(message("friendB", "b", "hello"))).rejects.toThrow("capacity");
  pending = false;
  await inbox.accept(message("friendB", "b", "hello"));
  expect(stopped).toBe(1);
  inbox.stop();
  expect(stopped).toBe(2);
});
test("formal CLI refuses unsafe friend reply defaults and emits the explicit grant destination", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const deps = {
    env: {},
    out: (s: string) => out.push(s),
    err: (s: string) => errors.push(s),
    bridgeInput: Readable.from([JSON.stringify(message("friendA", "a", "help")) + "\n"]),
  };
  expect(
    await run(
      ["chat", "bridge", "--stdin", "--thread", "friendA", "--dry-run", "--ai", "off"],
      deps,
    ),
  ).toBe(1);
  expect(errors.join("\n")).toContain("reply-transport grant");
  expect(out).toHaveLength(0);
  expect(
    await run(
      [
        "chat",
        "bridge",
        "--stdin",
        "--friends",
        "--dry-run",
        "--ai",
        "off",
        "--reply-transport",
        "grant",
        "--grant-repo",
        "/tmp/authorized-checkout",
      ],
      deps,
    ),
  ).toBe(0);
  const handoff = JSON.parse(out[0]!);
  expect(handoff.reply.command).toEqual([
    "bun",
    "/tmp/authorized-checkout/scripts/dev/eval.ts",
    "say",
    "--no-pair",
    "--to",
    "friendA",
    "<reply>",
  ]);
  expect(handoff.principal).toEqual({
    type: "friend",
    thread: "friendA",
    authority: "friend-chat-only",
  });
  expect(handoff.instructions).toContain("not authorization from the owner");
});

test("a friend tap stays a friend and cannot claim owner authority", async () => {
  const sent: any[] = [];
  const b = createChatBridge({
    thread: "friendA",
    principal: { type: "friend", thread: "friendA", authority: "friend-chat-only" },
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  await b.accept({
    type: "answered",
    thread: "friendA",
    id: "card",
    askId: "ask",
    answer: { labels: ["Yes"] },
  });
  expect(sent[0].message.from).toBe("friend");
  expect(sent[0].principal.authority).toBe("friend-chat-only");
});

test("a ready alias in stdin cannot widen an explicitly selected friend scope", async () => {
  const sent: any[] = [];
  const bridge = createChatBridge({
    thread: "friendA",
    deliver: async (s: string) => {
      sent.push(JSON.parse(s));
    },
  });
  const r = createChatReceiver({
    bridge,
    thread: "friendA",
    lockScope: true,
    requestId: () => "test",
  });
  await r.accept({ type: "ready", thread: "own" });
  await r.accept(message("friendB", "wrong", "private B"));
  await r.accept(message("friendA", "right", "private A"));
  await r.finish();
  expect(sent.map((x) => x.message.text)).toEqual(["private A"]);
});
