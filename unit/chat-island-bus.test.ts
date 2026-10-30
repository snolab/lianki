import { describe, expect, it } from "bun:test";
import {
  CHAT_OPEN_ACTION,
  ISLAND_ACTION_EVENT,
  chatOpenFrom,
  onChatOpen,
} from "@lianki/debug-chat/island-bus";

describe("chatOpenFrom", () => {
  it("takes chat.open, with or without a node", () => {
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: {} })).toEqual({});
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION })).toEqual({});
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: { node: "/words/swipe" } })).toEqual({
      node: "/words/swipe",
    });
  });

  it("drops other actions and payloads that do not fit the contract", () => {
    expect(chatOpenFrom(null)).toBeNull();
    expect(chatOpenFrom("chat.open")).toBeNull();
    expect(chatOpenFrom({ name: "nav.drawer", payload: {} })).toBeNull();
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: { node: 7 } })).toBeNull();
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: { node: "x".repeat(201) } })).toBeNull();
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: [] })).toBeNull();
    expect(chatOpenFrom({ name: CHAT_OPEN_ACTION, payload: "x" })).toBeNull();
  });
});

describe("onChatOpen", () => {
  it("calls the handler for chat.open on the bus, and stops on unsubscribe", () => {
    const bus = new EventTarget();
    const got: unknown[] = [];
    const off = onChatOpen((p) => got.push(p), bus);
    const send = (detail: unknown) =>
      bus.dispatchEvent(new CustomEvent(ISLAND_ACTION_EVENT, { detail }));
    send({ name: CHAT_OPEN_ACTION, payload: { node: "/plan" } });
    send({ name: "nav.drawer", payload: {} });
    send({ name: CHAT_OPEN_ACTION, payload: { node: 1 } });
    off();
    send({ name: CHAT_OPEN_ACTION, payload: {} });
    expect(got).toEqual([{ node: "/plan" }]);
  });

  it("listens on window by default", () => {
    const g = globalThis as unknown as { window?: EventTarget };
    const had = g.window;
    g.window = new EventTarget();
    try {
      const got: unknown[] = [];
      const off = onChatOpen((p) => got.push(p));
      g.window.dispatchEvent(
        new CustomEvent(ISLAND_ACTION_EVENT, { detail: { name: CHAT_OPEN_ACTION } }),
      );
      off();
      expect(got).toEqual([{}]);
    } finally {
      if (had) g.window = had;
      else delete g.window;
    }
  });
});
