// scripts/dev/lane-listen.ts: a lane's own chat listener (docs/lane-listen.md).
// Its pure parts: where the lane token comes from (never printed), reading
// both listeners' JSON lines, and what the lane's agent is handed.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_SKILL,
  handoff,
  handoffBrief,
  jst,
  laneToken,
  lineOf,
  briefBullet,
  makeDeliverer,
  urgentLine,
  voiceAllowed,
  tokenNeeded,
} from "../scripts/dev/lane-listen-lib";

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

describe("state-tree lines addressed to a lane (docs/state-tree.md, Blocked and paused)", () => {
  it("an eta line with eta.lane is this lane's; its hand-off says it is automatic", () => {
    const raw = JSON.stringify({
      type: "chat",
      message: {
        id: "n1",
        thread: "owner",
        from: "agent",
        source: "eta",
        text: "@codex: Rebase: x (/w/r) is blocked on you: 合并 #812.",
        at: Date.UTC(2026, 10, 10, 20, 0),
        eta: { id: "/w/r", etaAt: 1, kind: "blocked", lane: "codex" },
      },
    });
    const l = lineOf(raw)!;
    expect(l.etaLane).toBe("codex");
    const text = handoff("codex", l, "/repo");
    expect(text).toStartWith("【state tree → codex】(05:00 JST, automatic) @codex:");
    expect(text).toContain("say --repo /repo --as codex");
    // An owner line carrying eta fields is not one.
    const typed = JSON.parse(raw);
    typed.message.from = "owner";
    expect(lineOf(JSON.stringify(typed))!.etaLane).toBeUndefined();
  });
});

describe("handoff: a line heard by a listen-to-all lane", () => {
  it("says it was not addressed and to stay silent unless meant for it", () => {
    const l = lineOf(
      JSON.stringify({
        type: "chat",
        message: { id: "m1", from: "owner", thread: "owner", text: "今天学了什么", at: 0 },
      }),
    )!;
    const text = handoff("codex", l, "/repo");
    expect(text).toContain("not addressed to you by name");
    expect(text).toContain("say --repo /repo --as codex");
  });
});

describe("brief hand-offs and busy-time batching (owner, 2026-11-14)", () => {
  const line = (id: string, text: string, at = "2026-11-14T07:17:00Z") => ({
    id,
    thread: "owner",
    from: "owner",
    text,
    at,
  });
  it("handoffBrief: one header, one bullet per line, @你 only when he said the name, the skill once", () => {
    const b = handoffBrief(
      "codex",
      [line("a1", "小克，看一下"), line("a2", "coco，你在吗")],
      "/repo",
      true,
    );
    const rows = b.split("\n");
    expect(rows[0]).toMatch(/^【owner → codex】\d\d:\d\d JST$/);
    expect(rows[1]).toBe("- (id:a1) 小克，看一下");
    expect(rows[2]).toBe("- (id:a2) @你 coco，你在吗");
    expect(rows[3]).toContain(HANDOFF_SKILL);
    expect(rows[3]).toContain("reply --as codex --id <id>");
    expect(handoffBrief("codex", [line("a3", "嗯")], "/repo", false).split("\n")).toHaveLength(2);
  });
  it("makeDeliverer: lines wait while the agent is busy, then go as one message", async () => {
    const sent: string[] = [];
    let busy = true;
    const d = makeDeliverer(
      { lane: "codex", repo: "/repo", tests: false, dryRun: true, all: true } as Parameters<
        typeof makeDeliverer
      >[0],
      async (body) => {
        sent.push(body);
        return 0;
      },
      async () => busy,
      () => {},
      5,
    );
    await d.add(line("b1", "第一句"));
    await d.add(line("b2", "第二句"));
    expect(sent).toEqual([]);
    expect(d.pending()).toBe(2);
    busy = false;
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("(id:b1) 第一句");
    expect(sent[0]).toContain("(id:b2) 第二句");
    expect(sent[0]).toContain(HANDOFF_SKILL);
    await d.add(line("b3", "第三句"));
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toContain(HANDOFF_SKILL);
  });
  it("makeDeliverer: his name or a roll call breaks in at once, with what was waiting", async () => {
    const sent: [string, boolean][] = [];
    const d = makeDeliverer(
      { lane: "codex", repo: "/repo", tests: false, dryRun: true, all: true } as Parameters<
        typeof makeDeliverer
      >[0],
      async (body, interrupt) => {
        sent.push([body, interrupt]);
        return 0;
      },
      async () => true,
      () => {},
      5,
    );
    await d.add(line("c1", "先攒着"));
    expect(sent).toEqual([]);
    await d.add(line("c2", "coco，你在吗"));
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe(true);
    expect(sent[0][0]).toContain("(id:c1) 先攒着");
    expect(sent[0][0]).toContain("(id:c2) @你 coco，你在吗");
    await d.add(line("c3", "全体报数"));
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toBe(true);
    expect(sent[1][0]).toContain("@你 全体报数");
    await d.add(line("c3b", "报数"));
    expect(sent).toHaveLength(2);
    await d.add(line("c4", "随便一句"));
    expect(sent).toHaveLength(2);
    expect(d.pending()).toBe(2);
    expect(urgentLine("codex", { ...line("c5", "x"), etaLane: "codex" })).toBe(true);
  });
  it("only his own voice goes to the lanes: other never, unknown marked (or dropped with LANE_LISTEN_VOICES=me)", () => {
    const raw = (decision: string) =>
      JSON.stringify({
        type: "chat",
        message: { id: "v1", from: "owner", text: "你们好", speaker: { decision } },
      });
    expect(lineOf(raw("other"))?.voice).toBe("other");
    expect(voiceAllowed({ from: "owner", voice: "other" })).toBe(false);
    expect(voiceAllowed({ from: "owner", voice: "me" })).toBe(true);
    expect(voiceAllowed({ from: "owner" })).toBe(true);
    expect(voiceAllowed({ from: "owner", voice: "unknown" }, {})).toBe(true);
    expect(voiceAllowed({ from: "owner", voice: "unknown" }, { LANE_LISTEN_VOICES: "me" })).toBe(
      false,
    );
    expect(briefBullet("codex", { ...line("v2", "短句"), voice: "unknown" })).toBe(
      "- (id:v2)（声纹未定） 短句",
    );
  });
});
