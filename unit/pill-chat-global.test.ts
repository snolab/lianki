import { describe, expect, it } from "bun:test";
import {
  GLOBAL_CHAT_KEY,
  MAX_CHAT_SITES,
  chatSiteExcluded,
  globalChatAllowed,
  globalChatStore,
  parseGlobalChat,
} from "../src/pill-chat-global";
import { LICHAT_SITES_KEY } from "../src/pill-chat-trust";
const setup = () => {
  const values = new Map<string, unknown>();
  const store = globalChatStore({
    getValue: (k, d) => (values.has(k) ? values.get(k) : d),
    setValue: (k, v) => {
      values.set(k, v);
    },
  });
  return { values, store };
};
describe("portable Li global consent", () => {
  it("does not upgrade old per-site approvals into approval for all websites", () => {
    const { values, store } = setup();
    values.set(
      LICHAT_SITES_KEY,
      JSON.stringify({ "example.test": "allow", "blocked.test": "never" }),
    );
    expect(store.read().consent).toBe("unknown");
    expect(globalChatAllowed(store.read(), "example.test", "account_a")).toBe(false);
    expect(store.consent("all", "account_a")).toBe(true);
    expect(globalChatAllowed(store.read(), "example.test", "account_a")).toBe(true);
    expect(globalChatAllowed(store.read(), "another.test", "account_a")).toBe(true);
    expect(globalChatAllowed(store.read(), "blocked.test", "account_a")).toBe(false);
    expect(values.has("lk:token")).toBe(false);
  });
  it("never drops legacy denials when the new bounded exclusion list is full", () => {
    const { values, store } = setup();
    values.set(
      LICHAT_SITES_KEY,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: MAX_CHAT_SITES + 5 }, (_, i) => [`blocked${i}.test`, "never"]),
        ),
      ),
    );
    store.consent("all", "account_a");
    expect(globalChatAllowed(store.read(), `blocked${MAX_CHAT_SITES + 4}.test`, "account_a")).toBe(
      false,
    );
    expect(JSON.parse(String(values.get(GLOBAL_CHAT_KEY))).excluded.length).toBeLessThanOrEqual(
      MAX_CHAT_SITES,
    );
    expect(store.exclude("extra.test", true)).toBe(false);
  });
  it("withdraws global consent and never transfers it to another account", () => {
    const { store } = setup();
    store.consent("all", "account_a");
    expect(globalChatAllowed(store.read(), "example.test", "account_b")).toBe(false);
    store.bind("account_b");
    expect(store.read().consent).toBe("unknown");
    store.consent("all", "account_b");
    store.consent("off", "account_b");
    expect(globalChatAllowed(store.read(), "example.test", "account_b")).toBe(false);
    store.bind("account_c");
    expect(store.read().consent).toBe("off");
    expect(store.consent("all", "not an account")).toBe(false);
  });
  it("excludes a website and its subdomains, without matching unrelated names", () => {
    const { store } = setup();
    store.consent("all", "account_a");
    store.exclude("zhihu.com", true);
    expect(chatSiteExcluded(store.read(), "zhihu.com")).toBe(true);
    expect(chatSiteExcluded(store.read(), "www.zhihu.com")).toBe(true);
    expect(chatSiteExcluded(store.read(), "notzhihu.com")).toBe(false);
    expect(chatSiteExcluded(store.read(), "zhihu.com.evil.test")).toBe(false);
    store.exclude("zhihu.com", false);
    expect(globalChatAllowed(store.read(), "www.zhihu.com", "account_a")).toBe(true);
  });
  it("removes an old explicit denial only when the user removes that exclusion", () => {
    const { values, store } = setup();
    values.set(LICHAT_SITES_KEY, JSON.stringify({ "example.test": "never" }));
    store.consent("all", "account_a");
    expect(chatSiteExcluded(store.read(), "example.test")).toBe(true);
    store.exclude("example.test", false);
    expect(chatSiteExcluded(store.read(), "example.test")).toBe(false);
  });
  it("remembers collapse per website without collapsing other websites or changing consent", () => {
    const { store } = setup();
    store.consent("all", "account_a");
    store.collapse("example.test", true);
    expect(store.read().collapsed).toEqual(["example.test"]);
    expect(globalChatAllowed(store.read(), "other.test", "account_a")).toBe(true);
    expect(store.read().collapsed.includes("other.test")).toBe(false);
    store.collapse("example.test", false);
    expect(store.read().collapsed).toEqual([]);
    expect(store.read().consent).toBe("all");
  });
  it("bounds stored site lists and refuses malformed policy rather than granting access", () => {
    const { values, store } = setup();
    for (const raw of [
      null,
      "{",
      [],
      { version: 2, consent: "all", principal: "account_a" },
      { version: 1, consent: "all" },
    ]) {
      values.set(GLOBAL_CHAT_KEY, raw);
      expect(store.read().consent).toBe("unknown");
    }
    values.delete(GLOBAL_CHAT_KEY);
    store.consent("all", "account_a");
    for (let i = 0; i < MAX_CHAT_SITES + 5; i++) store.collapse(`site${i}.test`, true);
    expect(store.read().collapsed).toHaveLength(MAX_CHAT_SITES);
    expect(store.exclude("https://bad.test", true)).toBe(false);
    expect(store.collapse("not a host", true)).toBe(false);
    expect(store.bind("invalid principal")).toBe(false);
    expect(
      parseGlobalChat({
        version: 1,
        consent: "all",
        principal: "account_a",
        excluded: ["evil.test", "bad host", "evil.test"],
      }),
    ).toMatchObject({ excluded: ["evil.test"] });
  });
});
