// scripts/dev/lane-listen.ts: a lane's own chat listener (docs/lane-listen.md).
// Its pure parts: where the lane token comes from (never printed), reading
// both listeners' JSON lines, and what the lane's agent is handed.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoff, jst, laneToken, lineOf, tokenNeeded } from "../scripts/dev/lane-listen-lib";

const dir = mkdtempSync(join(tmpdir(), "lane-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const FAKE = `lk_${"ab".repeat(32)}`;

describe("laneToken", () => {
  it("LIANKI_TOKEN first", () => {
    expect(laneToken("codex", { LIANKI_TOKEN: ` ${FAKE} `, LIANKI_LANE_TOKEN_DIR: dir })).toEqual({
      token: FAKE,
      from: "env",
    });
  });
  it("else the lane's file, only when it is 0600 and holds an lk_ token", () => {
    const env = { LIANKI_LANE_TOKEN_DIR: dir };
    expect(laneToken("codex", env).from).toBe("none");
    const p = join(dir, "codex.token");
    writeFileSync(p, `${FAKE}\n`);
    chmodSync(p, 0o644);
    const loose = laneToken("codex", env);
    expect(loose.from).toBe("none");
    expect("why" in loose && loose.why).toContain("chmod 600");
    chmodSync(p, 0o600);
    expect(laneToken("codex", env)).toEqual({ token: FAKE, from: "file" });
    writeFileSync(p, "not a token");
    expect(laneToken("codex", env).from).toBe("none");
  });
  it("no lane, or a lane name that is a path: nothing", () => {
    expect(laneToken(undefined, { LIANKI_LANE_TOKEN_DIR: dir }).from).toBe("none");
    expect(laneToken("../x", { LIANKI_LANE_TOKEN_DIR: dir }).from).toBe("none");
  });
  it("what to ask the owner for names the lane, chat permissions only, an expiry", () => {
    const t = tokenNeeded("agy");
    expect(t).toContain('name "agy"');
    expect(t).toContain("chat:read chat:write chat:ask");
    expect(t).toContain("expiry");
  });
});

describe("lineOf", () => {
  it("reads `lianki chat listen --json` lines", () => {
    const l = lineOf(
      JSON.stringify({
        type: "chat",
        message: {
          id: "a1",
          thread: "owner",
          from: "owner",
          text: "codex, hi",
          at: 1_794_000_000_000,
        },
      }),
    );
    expect(l).toMatchObject({
      id: "a1",
      thread: "owner",
      from: "owner",
      text: "codex, hi",
      history: false,
    });
    expect(l?.at).toBe(new Date(1_794_000_000_000).toISOString());
  });
  it("reads eval.ts chat lines", () => {
    expect(
      lineOf(
        JSON.stringify({
          type: "chat",
          id: "b2",
          thread: "owner",
          from: "owner",
          text: "agy, hi",
          at: "2026-11-09T00:00:00Z",
        }),
      ),
    ).toMatchObject({ id: "b2", text: "agy, hi" });
  });
  it("marks history; drops other events and junk", () => {
    expect(
      lineOf(JSON.stringify({ type: "chat", message: { id: "c", text: "x" }, history: true }))
        ?.history,
    ).toBe(true);
    expect(lineOf(JSON.stringify({ type: "answered", id: "d" }))).toBeNull();
    expect(lineOf("not json")).toBeNull();
    expect(lineOf(JSON.stringify({ type: "chat", message: { id: 3, text: "x" } }))).toBeNull();
  });
});

describe("handoff", () => {
  it("his words, the JST time, and the reply command as the lane", () => {
    const h = handoff(
      "codex",
      {
        id: "a",
        thread: "owner",
        from: "owner",
        text: "codex, 看一下 #700",
        at: "2026-11-08T16:06:00Z",
      },
      "/r",
    );
    expect(h).toStartWith("【owner → codex】(01:06 JST, Li chat) codex, 看一下 #700");
    expect(h).toContain("only you got it");
    expect(h).toContain('bun /r/scripts/dev/lianki-dev.ts say --repo /r --as codex "<your reply>"');
    expect(h).not.toContain("lk_");
  });
  it("a test line says it is a test", () => {
    const h = handoff(
      "agy",
      { id: "t", thread: "owner", from: "agent", text: "【main】[lane-test] agy, ping" },
      "/r",
    );
    expect(h).toStartWith("【lane-test → agy】");
    expect(h).toContain("agy, ping");
    expect(h).toContain('starting "[lane-test] "');
  });
  it("jst", () => {
    expect(jst("2026-11-08T23:59:00Z")).toBe("08:59");
  });
});
