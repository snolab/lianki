import { expect, test } from "bun:test";
import { readAckBody, readWindow, readCoverage } from "../packages/lianki-cli/chat-seq.mjs";
import { run } from "../packages/lianki-cli/cli.mjs";
import { TOOLS, runTool } from "../packages/lianki-cli/mcp-tools.mjs";

test("explicit read acknowledgements and recovery windows validate safe sequence values", () => {
  expect(readAckBody(0)).toEqual({ op: "read-ack", lastReadSeq: 0 });
  expect(readAckBody(9)).toEqual({ op: "read-ack", lastReadSeq: 9 });
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", undefined])
    expect(() => readAckBody(value)).toThrow();
  expect(readWindow(undefined, undefined)).toEqual({});
  expect(readWindow(0, undefined)).toEqual({ afterSeq: 0 });
  expect(readWindow(2, 5)).toEqual({ afterSeq: 2, throughSeq: 5 });
  for (const [after, through] of [
    [undefined, 1],
    [-1, 5],
    [2, 1],
    [0, NaN],
    ["0", 1],
  ])
    expect(() => readWindow(after, through)).toThrow();
  expect(readCoverage(undefined)).toEqual({});
  expect(readCoverage({ afterSeq: -1, headSeq: "7", removed: null })).toEqual({});
  const coverage = {
    afterSeq: 1,
    throughSeq: 4,
    headSeq: 8,
    prunedThroughSeq: 0,
    skipped: [{ from: 2, to: 3 }],
    removed: [{ id: "gone", seq: 4 }],
  };
  expect(readCoverage({ ...coverage, private: "not copied" })).toEqual(coverage);
});

test("CLI read never acknowledges implicitly; seen posts exactly the explicit cursor", async () => {
  const calls: unknown[] = [];
  const out: string[] = [];
  const deps: any = {
    env: { LIANKI_TOKEN: `lk_${"a".repeat(64)}`, LIANKI_NO_KEYCHAIN: "1" },
    version: "0.0.0",
    out: (s: string) => out.push(s),
    err: (s: string) => out.push(s),
    fetch: async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return Response.json(
        body.op === "read-ack"
          ? { ok: true, lastReadSeq: 7 }
          : {
              messages: [],
              afterSeq: 1,
              throughSeq: 4,
              headSeq: 7,
              prunedThroughSeq: 0,
              skipped: [],
              removed: [],
            },
      );
    },
  };
  expect(
    await run(["chat", "read", "--after-seq", "1", "--through-seq", "4", "--json"], deps),
  ).toBe(0);
  expect(calls).toEqual([{ op: "read", limit: 30, afterSeq: 1, throughSeq: 4 }]);
  expect(out.join("\n")).toContain('"headSeq":7');
  expect(await run(["chat", "seen", "--seq", "7", "--json"], deps)).toBe(0);
  expect(calls.at(-1)).toEqual({ op: "read-ack", lastReadSeq: 7 });
  const count = calls.length;
  expect(await run(["chat", "seen", "--seq", "-1", "--json"], deps)).toBe(1);
  expect(calls).toHaveLength(count);
  expect(out.join("\n")).not.toContain(deps.env.LIANKI_TOKEN);
});

test("MCP separates read intent from explicit consumption acknowledgement", async () => {
  const calls: any[] = [];
  const api = async (request: unknown) => {
    calls.push(request);
    return { messages: [], headSeq: 9, throughSeq: 4, afterSeq: 0, prunedThroughSeq: 0 };
  };
  const read = TOOLS.find((t) => t.name === "lianki_chat_read")!;
  const seen = TOOLS.find((t) => t.name === "lianki_chat_seen")!;
  expect(seen.scope).toBe("chat:read");
  expect(seen.annotations.readOnlyHint).toBe(false);
  const result = await runTool(read, api, { afterSeq: 0, throughSeq: 4 });
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ op: "read", limit: 30, afterSeq: 0, throughSeq: 4 });
  expect(result.content[0].text).toMatch(/"headSeq":\s*9/);
  await runTool(seen, api, { lastReadSeq: 4 });
  expect(calls[1].body).toEqual({ op: "read-ack", lastReadSeq: 4 });
});
