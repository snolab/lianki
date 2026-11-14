import { describe, expect, test } from "bun:test";
import { migrateLegacyOwnerDraft } from "../packages/debug-chat/src/legacy-chat-draft";

const LEGACY = "lk:ui:chat";
const MARKER = "lk:ui:chat-legacy-owner";
const target = (scope: string) => `lk:ui:chat:${encodeURIComponent(scope)}`;
const state = (value: unknown) => JSON.stringify({ state: value, version: 1 });
function fixture() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  let fail: ((key: string) => boolean) | null = null;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail?.(key)) throw Error("storage write denied");
      writes.push(key);
      data.set(key, value);
    },
    removeItem: (key: string) => {
      if (fail?.(key)) throw Error("storage removal denied");
      writes.push(`remove:${key}`);
      data.delete(key);
    },
  };
  return {
    data,
    writes,
    storage,
    fail: (f: typeof fail) => {
      fail = f;
    },
    run: (scope: string | null = "owner-a", owner = true) =>
      migrateLegacyOwnerDraft({ storage, scope, owner }),
  };
}

describe("one-time owner legacy chat input migration", () => {
  test("claims and durably copies pending input before deleting legacy; keeps scoped UI unrelated to input", () => {
    const f = fixture();
    f.data.set(
      LEGACY,
      state({
        draft: "old spoken words",
        pureDictation: "old spoken words",
        caret: 3,
        interim: { text: "unfinished", page: 10 },
        attached: { selection: "selected words", path: "/words", title: "Words" },
        panel: "none",
      }),
    );
    f.data.set(
      target("owner-a"),
      state({ draft: "", panel: "tree", expandedOthers: ["keep-expanded"] }),
    );
    const restored = f.run();
    expect(restored).toMatchObject({
      draft: "old spoken words",
      pureDictation: "old spoken words",
      caret: 3,
      interim: { text: "unfinished", page: 10 },
      panel: "tree",
      expandedOthers: ["keep-expanded"],
      legacyOwnerMigrated: true,
    });
    expect(restored?.attached?.selection).toBe("selected words");
    expect(JSON.parse(f.data.get(target("owner-a"))!).state).toMatchObject({
      draft: "old spoken words",
      legacyOwnerMigrated: true,
    });
    expect(f.data.has(LEGACY)).toBe(false);
    expect(f.data.has(MARKER)).toBe(true);
    expect(f.writes.indexOf(MARKER)).toBeLessThan(f.writes.indexOf(target("owner-a")));
    expect(f.writes.indexOf(target("owner-a"))).toBeLessThan(f.writes.indexOf(`remove:${LEGACY}`));
  });

  test("migration never repeats after success, even if an old bundle writes the legacy key again", () => {
    const f = fixture();
    f.data.set(LEGACY, state({ draft: "once" }));
    f.run();
    f.data.set(target("owner-a"), state({ draft: "", legacyOwnerMigrated: true }));
    f.data.set(LEGACY, state({ draft: "old bundle rewrote it" }));
    const before = f.data.get(target("owner-a"));
    expect(f.run()).toBeNull();
    expect(f.run("owner-b")).toBeNull();
    expect(f.data.get(target("owner-a"))).toBe(before);
    expect(f.data.has(target("owner-b"))).toBe(false);
  });

  test("guests, friends and non-owner accounts cannot claim or remove the legacy text", () => {
    const f = fixture();
    const raw = state({ draft: "owner's pending words" });
    f.data.set(LEGACY, raw);
    expect(f.run(null, true)).toBeNull();
    expect(f.run("friend-account", false)).toBeNull();
    expect(f.run("signed-in-nonowner", false)).toBeNull();
    expect(f.run("", true)).toBeNull();
    expect(f.data.get(LEGACY)).toBe(raw);
    expect(f.writes).toEqual([]);
  });

  test("existing scoped words defer migration without concatenation, overwrite or order changes", () => {
    for (const current of [
      { draft: "newer typed words" },
      { interim: { text: "currently speaking", page: 30 } },
    ]) {
      const f = fixture();
      const old = state({ draft: "legacy older words" });
      const now = state(current);
      f.data.set(LEGACY, old);
      f.data.set(target("owner-a"), now);
      expect(f.run()).toBeNull();
      expect(f.data.get(LEGACY)).toBe(old);
      expect(f.data.get(target("owner-a"))).toBe(now);
    }
  });

  test("a failed target write preserves legacy input and its claim, allowing only the same account to retry", () => {
    const f = fixture();
    const raw = state({ draft: "do not lose" });
    f.data.set(LEGACY, raw);
    f.fail((key) => key === target("owner-a"));
    expect(f.run()).toBeNull();
    expect(f.data.get(LEGACY)).toBe(raw);
    expect(f.data.has(target("owner-a"))).toBe(false);
    expect(f.run("owner-b")).toBeNull();
    expect(f.data.has(target("owner-b"))).toBe(false);
    f.fail(null);
    expect(f.run()).toMatchObject({ draft: "do not lose", legacyOwnerMigrated: true });
    expect(f.data.has(LEGACY)).toBe(false);
  });

  test("a failed claim never writes or deletes input, and a failed deletion never repeats the copy", () => {
    const f = fixture();
    const raw = state({ draft: "recoverable words" });
    f.data.set(LEGACY, raw);
    f.fail((key) => key === MARKER);
    expect(f.run()).toBeNull();
    expect(f.data.get(LEGACY)).toBe(raw);
    expect(f.data.has(target("owner-a"))).toBe(false);
    f.fail((key) => key === LEGACY);
    expect(f.run()).toMatchObject({ draft: "recoverable words", legacyOwnerMigrated: true });
    expect(f.data.get(LEGACY)).toBe(raw);
    const saved = f.data.get(target("owner-a"));
    f.fail(null);
    expect(f.run()).toBeNull();
    expect(f.data.get(target("owner-a"))).toBe(saved);
    expect(f.run("owner-b")).toBeNull();
  });

  test("completion-marker interruption cannot let another owner take already copied words or duplicate the copy", () => {
    const f = fixture();
    f.data.set(LEGACY, state({ draft: "already durable" }));
    let markerWrites = 0;
    f.fail((key) => key === MARKER && ++markerWrites === 2);
    f.run();
    expect(JSON.parse(f.data.get(target("owner-a"))!).state).toMatchObject({
      draft: "already durable",
      legacyOwnerMigrated: true,
    });
    expect(f.data.has(LEGACY)).toBe(true);
    const targetWrites = f.writes.filter((key) => key === target("owner-a")).length;
    expect(f.run("owner-b")).toBeNull();
    expect(f.data.has(target("owner-b"))).toBe(false);
    f.fail(null);
    f.run();
    expect(f.writes.filter((key) => key === target("owner-a"))).toHaveLength(targetWrites);
    expect(f.data.has(LEGACY)).toBe(false);
    expect(f.run()).toBeNull();
  });

  test("interim-only legacy input is recovered with its original page marker", () => {
    const f = fixture();
    f.data.set(LEGACY, state({ interim: { text: "half a sentence", page: 42 } }));
    expect(f.run("owner:/encoded")).toMatchObject({
      draft: "",
      pureDictation: null,
      interim: { text: "half a sentence", page: 42 },
      legacyOwnerMigrated: true,
    });
    expect(f.data.has(target("owner:/encoded"))).toBe(true);
  });

  test("missing, malformed or empty legacy data never creates an outgoing draft", () => {
    for (const raw of [
      undefined,
      "not json",
      "null",
      state({ draft: 7 }),
      state({ draft: " ", interim: null }),
    ]) {
      const f = fixture();
      if (raw !== undefined) f.data.set(LEGACY, raw);
      expect(f.run()).toBeNull();
      expect(f.data.has(target("owner-a"))).toBe(false);
    }
  });
});
