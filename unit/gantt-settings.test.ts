import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  GANTT_HIDE_DONE_KEY,
  readGanttHideDone,
  writeGanttHideDone,
} from "@lianki/debug-chat/gantt-settings";
import { stubGlobals } from "./support/globals";

describe("gantt-settings", () => {
  let restore: () => void;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    const fakeStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, String(val)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };
    restore = stubGlobals({
      window: { localStorage: fakeStorage },
      localStorage: fakeStorage,
    });
  });

  afterEach(() => {
    restore?.();
  });

  it("readGanttHideDone defaults to true when no value is stored", () => {
    expect(readGanttHideDone()).toBe(true);
  });

  it("readGanttHideDone returns false when 'false' is stored", () => {
    store.set(GANTT_HIDE_DONE_KEY, "false");
    expect(readGanttHideDone()).toBe(false);
  });

  it("readGanttHideDone returns true when 'true' is stored", () => {
    store.set(GANTT_HIDE_DONE_KEY, "true");
    expect(readGanttHideDone()).toBe(true);
  });

  it("writeGanttHideDone stores 'true' or 'false' in localStorage", () => {
    writeGanttHideDone(false);
    expect(store.get(GANTT_HIDE_DONE_KEY)).toBe("false");
    expect(readGanttHideDone()).toBe(false);

    writeGanttHideDone(true);
    expect(store.get(GANTT_HIDE_DONE_KEY)).toBe("true");
    expect(readGanttHideDone()).toBe(true);
  });

  it("handles environment without window/localStorage gracefully", () => {
    restore();
    restore = stubGlobals({ window: undefined });
    expect(readGanttHideDone()).toBe(true);
    expect(() => writeGanttHideDone(false)).not.toThrow();
  });

  it("handles localStorage throwing gracefully", () => {
    restore();
    const throwingStorage = {
      getItem: () => {
        throw new Error("QuotaExceeded or SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded or SecurityError");
      },
    };
    restore = stubGlobals({
      window: { localStorage: throwingStorage },
    });
    expect(readGanttHideDone()).toBe(true);
    expect(() => writeGanttHideDone(false)).not.toThrow();
  });
});
