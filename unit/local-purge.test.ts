import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearPurge, PURGE_KEY, queuePurge, readPurge } from "../lib/local-purge";

/** Minimal localStorage stand-in; bun's test env has no DOM. */
class MemStorage {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, String(v));
  removeItem = (k: string) => void this.map.delete(k);
}

const original = (globalThis as { localStorage?: unknown }).localStorage;

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
});
afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = original;
});

describe("purge queue", () => {
  it("queues urls for the userscript to forget", () => {
    queuePurge(["https://linkedin.com/a", "https://linkedin.com/b"]);
    expect(readPurge()?.urls).toEqual(["https://linkedin.com/a", "https://linkedin.com/b"]);
  });

  it("merges successive deletes instead of losing the earlier one", () => {
    // Two deletes before the userscript next runs must both survive.
    queuePurge(["https://a.test/1"]);
    queuePurge(["https://a.test/2"]);
    expect(readPurge()?.urls).toEqual(["https://a.test/1", "https://a.test/2"]);
  });

  it("de-duplicates repeats", () => {
    queuePurge(["https://a.test/1"]);
    queuePurge(["https://a.test/1"]);
    expect(readPurge()?.urls).toEqual(["https://a.test/1"]);
  });

  it("keeps the all flag sticky once set", () => {
    queuePurge([], { all: true });
    queuePurge(["https://a.test/1"]);
    const req = readPurge();
    expect(req?.all).toBe(true);
    expect(req?.urls).toEqual(["https://a.test/1"]);
  });

  it("writes nothing for an empty request", () => {
    queuePurge([]);
    expect(readPurge()).toBeNull();
  });

  it("survives a corrupt or foreign value rather than throwing", () => {
    localStorage.setItem(PURGE_KEY, "not json");
    expect(readPurge()).toBeNull();
    localStorage.setItem(PURGE_KEY, JSON.stringify({ nope: 1 }));
    expect(readPurge()).toBeNull();
  });

  it("clears", () => {
    queuePurge(["https://a.test/1"]);
    clearPurge();
    expect(readPurge()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    // Private windows and storage-blocked contexts: deleting from the cloud
    // still worked, the userscript just keeps its copy until next time.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(() => queuePurge(["https://a.test/1"])).not.toThrow();
    expect(readPurge()).toBeNull();
    expect(() => clearPurge()).not.toThrow();
  });
});
