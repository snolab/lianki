import { describe, expect, test } from "bun:test";
import {
  MIGRATED_KEY,
  type KeyStore,
  agentKey,
  getKey,
  isKey,
  migrateKeys,
  queryFlag,
  removeKey,
  setKey,
} from "@lianki/debug-chat/storage-keys";
import { AGENT_NAME_EN, chatStrings } from "@lianki/debug-chat/wire";

/** An in-memory Storage. */
function memory(init: Record<string, string> = {}): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

describe("lk:debug* → lk:agent* keys", () => {
  test("agentKey maps the legacy prefix only", () => {
    expect(agentKey("lk:debug")).toBe("lk:agent");
    expect(agentKey("lk:debug-chat-open")).toBe("lk:agent-chat-open");
    expect(agentKey("lk:paper")).toBe("lk:paper");
  });

  test("migration copies every legacy key once and keeps the old ones", () => {
    const s = memory({
      "lk:debug": "1",
      "lk:debug-chat-pos": '{"x":1,"y":2}',
      "lk:agent-chat-speak": "1",
      "lk:debug-chat-speak": "0",
      "lk:paper": "washi",
    });
    expect(migrateKeys(s)).toBe(2);
    expect(s.getItem("lk:agent")).toBe("1");
    expect(s.getItem("lk:agent-chat-pos")).toBe('{"x":1,"y":2}');
    // A new key already set wins over the legacy value.
    expect(s.getItem("lk:agent-chat-speak")).toBe("1");
    // Old keys stay for one release; unrelated keys are untouched.
    expect(s.getItem("lk:debug")).toBe("1");
    expect(s.getItem("lk:debug-chat-speak")).toBe("0");
    expect(s.getItem("lk:agent-paper" as string)).toBeNull();
    expect(s.getItem(MIGRATED_KEY)).toBe("1");
    // Once per device: a legacy key written later is not copied again.
    s.setItem("lk:debug-widget-src", "https://x");
    expect(migrateKeys(s)).toBe(0);
    expect(s.getItem("lk:agent-widget-src")).toBeNull();
  });

  test("reads new-then-old; writes and removes both", () => {
    const s = memory({ "lk:debug": "1" });
    expect(getKey("lk:debug", s)).toBe("1");
    s.setItem("lk:agent", "0");
    expect(getKey("lk:debug", s)).toBe("0");
    setKey("lk:debug-chat-open", "1", s);
    expect(s.getItem("lk:debug-chat-open")).toBe("1");
    expect(s.getItem("lk:agent-chat-open")).toBe("1");
    removeKey("lk:debug-chat-open", s);
    expect(getKey("lk:debug-chat-open", s)).toBeNull();
    expect(getKey("lk:debug", null)).toBeNull();
  });

  test("blocked storage reads as unset", () => {
    const blocked = {
      ...memory(),
      getItem: () => {
        throw new Error("blocked");
      },
    } as KeyStore;
    expect(getKey("lk:debug", blocked)).toBeNull();
    expect(migrateKeys(blocked)).toBe(0);
  });

  test("storage events match either name", () => {
    expect(isKey("lk:debug", "lk:debug")).toBe(true);
    expect(isKey("lk:agent", "lk:debug")).toBe(true);
    expect(isKey("lk:debug-tab", "lk:debug")).toBe(false);
    expect(isKey(null, "lk:debug")).toBe(false);
  });

  test("?agent= is an alias of ?debug=, and wins", () => {
    expect(queryFlag("?debug=1")).toBe("1");
    expect(queryFlag("?agent=1")).toBe("1");
    expect(queryFlag("?agent=0&debug=1")).toBe("0");
    expect(queryFlag("?x=1")).toBeNull();
  });
});

describe("chat strings", () => {
  test("English defaults name the feature, never 'debug'", () => {
    const t = chatStrings();
    expect(t.name).toBe(AGENT_NAME_EN);
    for (const v of Object.values(t)) {
      expect(v).not.toMatch(/debug/i);
      expect(v).not.toContain("{name}");
    }
    expect(t.message).toContain(AGENT_NAME_EN);
  });

  test("a localized name fills the templates", () => {
    const t = chatStrings({ name: "学习伙伴", message: "给{name}发消息…" });
    expect(t.message).toBe("给学习伙伴发消息…");
    expect(t.chatWith).toBe("Chat with your 学习伙伴");
  });
});
