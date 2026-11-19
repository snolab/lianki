import { expect, test } from "bun:test";
import { accountGlossary, glossaryOptions } from "../lib/stt-glossary-server";
import { defaultConfig } from "../lib/config";
import { checkPref } from "../lib/prefs/schema";
import { readSttGlossary, writeSttGlossary } from "../lib/stt-glossary-client";
import { SYNC_KEY } from "../packages/ui-state/src/account";
import { STT_HOTWORDS_KEY, STT_CORRECTIONS_KEY } from "../lib/stt-glossary";
import { stubGlobals } from "./support/globals";
import { handleStt } from "../lib/stt-handler";
import { postStt } from "../packages/debug-chat/src/mic";
import { glossaryAccount, readGlossaryPref, writeGlossaryPref } from "../lib/stt-glossary-storage";
import { prefBindings } from "../lib/prefs/bindings";

test("verified-account lookup reads new preferences on the next call without cross-account state", async () => {
  const rows = new Map([
    ["account-a", ["First"]],
    ["account-b", ["Second"]],
  ]);
  const bound: unknown[] = [];
  const db = {
    prepare: () => ({
      bind: (id: unknown) => {
        bound.push(id);
        return {
          all: async () => ({
            results: [{ key: "stt.hotwords", value: JSON.stringify(rows.get(String(id)) ?? []) }],
          }),
        };
      },
    }),
  };
  expect((await accountGlossary(db as any, "account-a", [], defaultConfig(), 100)).terms).toEqual([
    "First",
  ]);
  rows.set("account-a", ["Updated"]);
  expect((await accountGlossary(db as any, "account-a", [], defaultConfig(), 101)).terms).toEqual([
    "Updated",
  ]);
  expect((await accountGlossary(db as any, "account-b", [], defaultConfig(), 102)).terms).toEqual([
    "Second",
  ]);
  expect(bound).toEqual(["account-a", "account-a", "account-b"]);
  expect((await accountGlossary(null, "", [], defaultConfig(), 100)).terms).toEqual([]);
});
test("malformed stored vocabulary fails empty; context still ranks with bounded live knobs", async () => {
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({
          results: [
            { key: "stt.hotwords", value: "bad-json" },
            {
              key: "stt.corrections",
              value: JSON.stringify([{ heard: "heard", corrected: "correct", at: 0 }]),
            },
          ],
        }),
      }),
    }),
  };
  const c = defaultConfig();
  c["stt.glossaryTopK"] = 1;
  c["stt.glossaryContextChars"] = 8;
  expect(glossaryOptions(c).topK).toBe(1);
  expect(
    (await accountGlossary(db as any, "account-a", [{ text: "fresh fresh ignored", at: 0 }], c, 0))
      .terms,
  ).toEqual(["correct"]);
  const broken = {
    prepare: () => {
      throw Error("private-diagnostic");
    },
  };
  expect((await accountGlossary(broken as any, "account-a", [], c, 0)).terms).toEqual([]);
  c["stt.glossaryTopK"] = 0;
  expect((await accountGlossary(db as any, "account-a", [], c, 0)).terms).toEqual([]);
});
test("prefs allow only bounded explicit terms/pairs, never device URLs or injected objects", () => {
  expect(checkPref("stt.hotwords", ["Project Aurora", "北极星"])).toEqual([
    "Project Aurora",
    "北极星",
  ]);
  expect(
    checkPref("stt.corrections", [{ heard: "heard", corrected: "correct", at: 1 }]),
  ).toBeTruthy();
  for (const words of [
    ["https://device.invalid/path"],
    ["a@b.invalid"],
    ["x".repeat(65)],
    Array(25).fill("term"),
  ])
    expect(checkPref("stt.hotwords", words)).toBeUndefined();
  expect(
    checkPref("stt.corrections", [{ heard: "x", corrected: "y", at: 1, automatic: true }]),
  ).toBeUndefined();
});
test("client refuses another account before reading or writing vocabulary", async () => {
  const m = new Map([
    [SYNC_KEY, JSON.stringify({ userId: "account-a" })],
    [STT_HOTWORDS_KEY, JSON.stringify({ userId: "account-a", value: ["First"] })],
    [STT_CORRECTIONS_KEY, JSON.stringify({ userId: "account-a", value: [] })],
  ]);
  const restore = stubGlobals({
    localStorage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
    },
  });
  try {
    expect(readSttGlossary("account-a")?.hotwords).toEqual(["First"]);
    expect(readSttGlossary("account-b")).toBeNull();
    expect(await writeSttGlossary("account-b", ["Other"], [])).toBe(false);
    expect(await writeSttGlossary("account-a", ["x".repeat(65)], [])).toBe(false);
    m.set(STT_HOTWORDS_KEY, "bad");
    expect(readSttGlossary("account-a")).toEqual({ hotwords: [], corrections: [] });
    m.set(SYNC_KEY, "bad");
    expect(readSttGlossary("account-a")).toBeNull();
  } finally {
    restore();
  }
});
test("explicit save waits for sync and refuses pending or switched-account results", async () => {
  const m = new Map([[SYNC_KEY, JSON.stringify({ userId: "account-a", outbox: {} })]]);
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
  };
  let flush: () => Promise<void> = async () => {};
  let scans = 0;
  const sync = {
    pull: async () => {},
    scan: () => {
      scans++;
    },
    flush: () => flush(),
  };
  const restore = stubGlobals({
    window: { localStorage: storage },
    localStorage: storage,
    __lkPrefSync: sync,
    fetch: async () =>
      Response.json({
        user: "account-a",
        prefs: {
          "stt.hotwords": { value: JSON.parse(m.get(STT_HOTWORDS_KEY) ?? "{}").value ?? [] },
          "stt.corrections": { value: JSON.parse(m.get(STT_CORRECTIONS_KEY) ?? "{}").value ?? [] },
        },
      }),
  });
  try {
    expect(
      await writeSttGlossary(
        "account-a",
        ["Aurora"],
        [{ heard: "heard", corrected: "correct", at: 1 }],
      ),
    ).toBe(true);
    expect(scans).toBe(1);
    expect(JSON.parse(m.get(STT_HOTWORDS_KEY)!).value).toEqual(["Aurora"]);
    flush = async () => {
      m.set(SYNC_KEY, JSON.stringify({ userId: "account-a", outbox: { "stt.hotwords": {} } }));
    };
    expect(await writeSttGlossary("account-a", ["Next"], [])).toBe(false);
    flush = async () => {
      m.set(SYNC_KEY, JSON.stringify({ userId: "account-b" }));
    };
    expect(await writeSttGlossary("account-a", ["Next"], [])).toBe(false);
    m.set(SYNC_KEY, JSON.stringify({ userId: "account-a" }));
    flush = async () => {
      throw Error("private-error");
    };
    expect(await writeSttGlossary("account-a", ["Next"], [])).toBe(false);
  } finally {
    restore();
  }
});
test("atomic glossary envelopes reject stale values when the next account has no stored row", () => {
  const m = new Map([[SYNC_KEY, JSON.stringify({ userId: "account-a" })]]);
  const restore = stubGlobals({
    localStorage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
    },
  });
  try {
    expect(glossaryAccount()).toBe("account-a");
    writeGlossaryPref(STT_HOTWORDS_KEY, ["PrivateTerm"]);
    expect(readGlossaryPref(STT_HOTWORDS_KEY)).toEqual(["PrivateTerm"]);
    m.set(SYNC_KEY, JSON.stringify({ userId: "account-b" }));
    expect(readSttGlossary("account-b")).toEqual({ hotwords: [], corrections: [] });
    expect(readGlossaryPref(STT_HOTWORDS_KEY)).toBeUndefined();
    writeGlossaryPref(STT_HOTWORDS_KEY, ["NewTerm"]);
    expect(readGlossaryPref(STT_HOTWORDS_KEY)).toEqual(["NewTerm"]);
    m.set(STT_HOTWORDS_KEY, "bad");
    expect(readGlossaryPref(STT_HOTWORDS_KEY)).toBeUndefined();
    m.set(SYNC_KEY, "bad");
    expect(glossaryAccount()).toBeNull();
    writeGlossaryPref(STT_CORRECTIONS_KEY, []);
    expect(m.has(STT_CORRECTIONS_KEY)).toBe(false);
  } finally {
    restore();
  }
});
test("STT passes bounded context plus account glossary to provider, never URL or logs", async () => {
  const glossary = { terms: ["Aurora"], corrections: [] };
  let received: any;
  let context = "";
  const logs: unknown[] = [];
  const req = new Request("https://example.invalid/api/debug/stt", {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-lk-stt-context": encodeURIComponent("Term ".repeat(200)),
    },
    body: new Uint8Array([1]),
  });
  const res = await handleStt(req, {
    user: { id: "account-a" },
    owner: false,
    limit: () => ({ allowed: true, retryAfterMs: 0 }),
    log: (x) => logs.push(x),
    glossary: async (text) => {
      context = text;
      return glossary;
    },
    transcribe: async (opts) => {
      received = opts;
      return { text: "heard" };
    },
  });
  expect(res.status).toBe(200);
  expect(context.length).toBe(600);
  expect(received.glossary).toEqual(glossary);
  expect(JSON.stringify(logs)).not.toContain("Aurora");
  expect(req.url).not.toContain("Term");
});
test("glossary bindings use the captured account even if shared sync storage already changed", () => {
  const m = new Map([[SYNC_KEY, JSON.stringify({ userId: "account-b" })]]);
  let writes = 0;
  const restore = stubGlobals({
    localStorage: {
      getItem: (key: string) => m.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes++;
        m.set(key, value);
      },
    },
  });
  try {
    const binding = prefBindings().find((x) => x.key === "stt.hotwords")!;
    binding.set(["AccountATerm"], "account-a");
    expect(writes).toBe(1);
    expect(JSON.parse(m.get(STT_HOTWORDS_KEY)!)).toEqual({
      userId: "account-a",
      value: ["AccountATerm"],
    });
    expect(binding.get("account-b")).toBeUndefined();
    expect(binding.get("account-a")).toEqual(["AccountATerm"]);
  } finally {
    restore();
  }
});
test("private screens supply no glossary context to STT", async () => {
  const restore = stubGlobals({ document: { querySelector: () => ({}) } });
  let headers: any;
  try {
    await postStt(new Uint8Array([1]), (async (_u, init) => {
      headers = init?.headers;
      return Response.json({ text: "" });
    }) as typeof fetch);
    expect(headers).toEqual({ "content-type": "audio/wav" });
  } finally {
    restore();
  }
});
