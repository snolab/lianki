// scripts/dev/lane-listen.ts: a lane's own chat listener (docs/lane-listen.md).
// Its pure parts: where the lane token comes from (never printed), reading
// both listeners' JSON lines, and what the lane's agent is handed.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANSWER_UNNAMED_NOTE,
  ANSWER_UNNAMED_RULE,
  unnamedNote,
  FYI_NOTE,
  HANDOFF_SKILL,
  NO_CROSS_RULE,
  SYSTEM_MARK,
  agentMark,
  everyoneTakes,
  listenerTakes,
  ownLine,
  routeKey,
  NONE_NOTE,
  OTHER_NOTE,
  SEND_MAX_CHARS,
  addressee,
  batchNotes,
  firstLines,
  otherMark,
  handoff,
  handoffBrief,
  ownerAt,
  laneToken,
  lineOf,
  briefBullet,
  chunkLines,
  makeDeliverer,
  reconnectWait,
  RECONNECT_RESET_MS,
  urgentLine,
  voiceAllowed,
  tokenNeeded,
} from "../scripts/dev/lane-listen-lib";

// The times these print are in the machine's zone; pin it so the JST labels below hold anywhere.
process.env.LIANKI_OWNER_TZ = "Asia/Tokyo";

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
  it("ownerAt: the clock time in the owner's zone, labelled", () => {
    expect(ownerAt("2026-11-08T23:59:00Z")).toBe("08:59 JST");
    process.env.LIANKI_OWNER_TZ = "Europe/Berlin";
    expect(ownerAt("2026-11-08T23:59:00Z")).toBe("00:59 CET");
    process.env.LIANKI_OWNER_TZ = "UTC";
    expect(ownerAt("2026-11-08T23:59:00Z")).toBe("23:59 UTC");
    process.env.LIANKI_OWNER_TZ = "Asia/Tokyo";
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
    expect(rows[1]).toBe(OTHER_NOTE);
    expect(rows[2]).toBe("- (id:a1) 【FYI · 点名 小克，不是你】 小克，看一下");
    expect(rows[3]).toBe("- (id:a2) @你 coco，你在吗");
    expect(rows[4]).toBe(NO_CROSS_RULE);
    expect(rows[5]).toContain(HANDOFF_SKILL);
    expect(rows[5]).toContain("reply --as codex --id <id>");
    expect(handoffBrief("codex", [line("a3", "嗯")], "/repo", false).split("\n")).toEqual([
      expect.stringMatching(/^【owner → codex】/),
      NONE_NOTE,
      "- (id:a3) 嗯",
    ]);
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
  it("a long batch goes as several messages under ay send's limit; one huge line is cut", async () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      line(`L${i}`, "这是一句一百个字左右的话".repeat(8)),
    );
    const parts = chunkLines("codex", lines);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat().map((l) => l.id)).toEqual(lines.map((l) => l.id));
    for (const p of parts)
      expect(p.map((l) => briefBullet("codex", l)).join("\n").length).toBeLessThanOrEqual(800);
    const huge = chunkLines("codex", [line("H", "长".repeat(2000))]);
    expect(huge).toHaveLength(1);
    expect(huge[0][0].text.endsWith("…")).toBe(true);
    expect(briefBullet("codex", huge[0][0]).length).toBeLessThanOrEqual(800);
    const sent: string[] = [];
    let busy = true;
    const d2 = makeDeliverer(
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
    for (const l of lines) await d2.add(l);
    expect(sent).toEqual([]);
    busy = false;
    await new Promise((r) => setTimeout(r, 30));
    // The first message leaves room for the rule and the skill line, so it may take one part more.
    expect(sent.length).toBeGreaterThanOrEqual(parts.length);
    for (const b of sent) expect(b.length).toBeLessThanOrEqual(SEND_MAX_CHARS + 40);
    expect(sent.join("\n").match(/\(id:L\d+\)/g)).toHaveLength(lines.length);
    expect(sent[0]).toContain(HANDOFF_SKILL);
    expect(sent[1]).not.toContain(HANDOFF_SKILL);
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
    // 未定不送 (owner, 2026-11-15 15:44 JST): not to tier ② (his lines only) …
    expect(voiceAllowed({ from: "owner", voice: "unknown" }, {}, {})).toBe(false);
    // … unless lanes.forwardUnknownVoice flips it back;
    expect(
      voiceAllowed(
        { from: "owner", voice: "unknown" },
        {},
        { LIANKI_LANES_FORWARD_UNKNOWN_VOICE: "true" },
      ),
    ).toBe(true);
    // tier ① (every line) still gets it, marked, unless LANE_LISTEN_VOICES=me.
    expect(voiceAllowed({ from: "owner", voice: "unknown" }, { everyone: true }, {})).toBe(true);
    expect(
      voiceAllowed(
        { from: "owner", voice: "unknown" },
        { everyone: true },
        { LANE_LISTEN_VOICES: "me" },
      ),
    ).toBe(false);
    expect(voiceAllowed({ from: "owner", voice: "me" }, {}, {})).toBe(true);
    expect(voiceAllowed({ from: "owner", voice: "other" }, { everyone: true }, {})).toBe(false);
    expect(briefBullet("codex", { ...line("v2", "短句"), voice: "unknown" })).toBe(
      "- (id:v2)（声纹未定） 短句",
    );
  });
});

describe("only the lane he names answers (owner, 2026-11-15 15:0x JST)", () => {
  const line = (id: string, text: string) => ({ id, thread: "owner", from: "owner", text });
  it("three shapes: addressed to me, to another lane, to nobody", () => {
    expect(addressee("codex", "coco，看一下")).toEqual({ to: "mine" });
    expect(addressee("codex", "全体，报数")).toEqual({ to: "mine" });
    expect(addressee("mimiai", "全体都有，报数")).toEqual({ to: "mine" });
    expect(addressee("mimiai", "@小克 看一下")).toEqual({ to: "other", names: ["小克"] });
    expect(addressee("agy", "coco 和 小克，看一下")).toEqual({
      to: "other",
      names: ["coco", "小克"],
    });
    expect(addressee("codex", "今天学了什么")).toEqual({ to: "none" });
    expect(otherMark(["小克"])).toBe("【FYI · 点名 小克，不是你】");

    const mine = handoffBrief("mimiai", [line("m1", "全体，报数")], "/r", false).split("\n");
    expect(mine).toEqual([
      expect.stringMatching(/^【owner → mimiai】/),
      "- (id:m1) @你 全体，报数",
    ]);

    const other = handoffBrief("mimiai", [line("o1", "@小克 看一下")], "/r", false).split("\n");
    expect(other).toEqual([
      expect.stringMatching(/^【owner → mimiai】/),
      OTHER_NOTE,
      "- (id:o1) 【FYI · 点名 小克，不是你】 @小克 看一下",
    ]);
    expect(OTHER_NOTE).toContain("不要回答、不要代做");

    const none = handoffBrief(
      "mimiai",
      [line("n1", "今天学了什么"), line("n2", "还有这个")],
      "/r",
      false,
    ).split("\n");
    expect(none.filter((x) => x === NONE_NOTE)).toHaveLength(1);
    expect(none.slice(2)).toEqual(["- (id:n1) 今天学了什么", "- (id:n2) 还有这个"]);
  });
  it("another lane's line never breaks in; the notes skip state-tree and test lines", () => {
    expect(urgentLine("mimiai", line("u1", "@小克 看一下"))).toBe(false);
    expect(urgentLine("mimiai", line("u2", "全体，看一下"))).toBe(true);
    expect(
      batchNotes("codex", [
        { ...line("s1", "x"), etaLane: "codex" },
        { id: "t1", thread: "owner", from: "agent", text: "【main】[lane-test] agy, ping" },
      ]),
    ).toEqual([]);
  });
  it("the first message carries the rule; chunks leave room for the notes", () => {
    expect(firstLines("codex", "/r")[0]).toBe(NO_CROSS_RULE);
    expect(NO_CROSS_RULE).toContain("被点名的是别人时不插话、不代答、不追问");
    const lines = Array.from({ length: 6 }, (_, i) => line(`X${i}`, `小克，${"字".repeat(150)}`));
    for (const p of chunkLines("codex", lines, 400))
      expect(handoffBrief("codex", p, "/r", false).length).toBeLessThanOrEqual(400 + 30);
    const huge = chunkLines("codex", [line("H", `小克，${"长".repeat(900)}`)], 400);
    expect([OTHER_NOTE, briefBullet("codex", huge[0]![0]!)].join("\n").length).toBeLessThanOrEqual(
      400,
    );
  });
  it("a lane that answers unnamed lines (answerUnnamed): its own note and rule; others' lines stay unanswered", () => {
    const yes = { answerUnnamed: true };
    expect(unnamedNote()).toBe(NONE_NOTE);
    expect(unnamedNote(yes)).toBe(ANSWER_UNNAMED_NOTE);
    expect(ANSWER_UNNAMED_NOTE).toBe(
      "未点名：有想法就简短答（1–3 句），没想法不回；点名你的必答。",
    );
    const none = [line("n1", "今天学了什么")];
    expect(handoffBrief("codex", none, "/r", false, yes).split("\n")).toEqual([
      expect.stringMatching(/^【owner → codex】/),
      ANSWER_UNNAMED_NOTE,
      "- (id:n1) 今天学了什么",
    ]);
    expect(handoffBrief("codex", none, "/r", false).split("\n")[1]).toBe(NONE_NOTE);
    // A line naming another lane: OTHER_NOTE in both modes.
    const mixed = [line("o1", "@小克 看一下"), line("n2", "嗯")];
    expect(batchNotes("agy", mixed, yes)).toEqual([OTHER_NOTE, ANSWER_UNNAMED_NOTE]);
    expect(batchNotes("agy", mixed)).toEqual([OTHER_NOTE, NONE_NOTE]);
    // The first message: the matching rule.
    expect(firstLines("agy", "/r", yes)[0]).toBe(ANSWER_UNNAMED_RULE);
    expect(firstLines("agy", "/r")[0]).toBe(NO_CROSS_RULE);
    expect(ANSWER_UNNAMED_RULE).toContain("被点名的是别人时不插话、不代答、不追问");
    const first = handoffBrief("agy", none, "/r", true, yes).split("\n");
    expect(first).toContain(ANSWER_UNNAMED_RULE);
    expect(first).not.toContain(NO_CROSS_RULE);
    // The long form agrees.
    const long = handoff("codex", line("h2", "今天学了什么"), "/r", yes);
    expect(long).toContain(ANSWER_UNNAMED_NOTE);
    expect(long).toContain("briefly");
    expect(handoff("codex", line("h1", "@小克 看一下"), "/r", yes)).toContain("do not answer");
    // Chunks leave room for the longer note.
    const many = Array.from({ length: 6 }, (_, i) => line(`Y${i}`, "字".repeat(150)));
    for (const p of chunkLines("codex", many, 400, yes))
      expect(handoffBrief("codex", p, "/r", false, yes).length).toBeLessThanOrEqual(400 + 30);
  });
  it("makeDeliverer with answerUnnamed hands the lane its rule and note", async () => {
    const sent: string[] = [];
    const d = makeDeliverer(
      { lane: "agy", repo: "/repo", answerUnnamed: true },
      async (body) => {
        sent.push(body);
        return 0;
      },
      async () => false,
    );
    await d.add(line("u1", "今天学了什么"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(ANSWER_UNNAMED_NOTE);
    expect(sent[0]).toContain(ANSWER_UNNAMED_RULE);
    expect(sent[0]).not.toContain(NONE_NOTE);
  });
  it("handoff (the long form) says the same", () => {
    const other = handoff("mimiai", line("h1", "@小克 看一下"), "/r");
    expect(other).toContain("【FYI · 点名 小克，不是你】");
    expect(other).toContain("do not answer");
    expect(handoff("codex", line("h2", "今天学了什么"), "/r")).toContain(NONE_NOTE);
    expect(handoff("codex", line("h3", "全体，报数"), "/r")).toContain("only you got it");
  });
});

describe("reconnectWait", () => {
  it("a socket that lived a while reconnects at once; quick failures back off", () => {
    // After a quiet night (its socket died unseen; the keepalive ended it): 1 s, inside the 30 s grace.
    expect(reconnectWait(32_000, 4, RECONNECT_RESET_MS)).toEqual({ wait: 1_000, next: 2_000 });
    expect(reconnectWait(32_000, 4, 5_000)).toEqual({ wait: 32_000, next: 60_000 });
    expect(reconnectWait(60_000, 4, 0).next).toBe(60_000);
    expect(reconnectWait(400_000, 5, 0)).toEqual({ wait: 400_000, next: 600_000 });
  });
});

describe("--everyone: agents' lines and system lines too (tier ①, owner 2026-11-15 15:1x JST)", () => {
  const raw = (m: Record<string, unknown>) =>
    JSON.stringify({
      type: "chat",
      message: { thread: "owner", at: "2026-11-15T06:20:00Z", ...m },
    });
  const coco = lineOf(
    raw({
      id: "c1",
      from: "agent",
      label: "codex",
      text: "【codex】done, PR #12",
      tokenLane: "codex",
      lane: "codex",
    }),
  )!;
  const sys = lineOf(
    raw({
      id: "s1",
      from: "agent",
      label: "lanes",
      text: "coco 开始实时监听",
      laneEvent: { lane: "codex", name: "coco", kind: "listening" },
    }),
  )!;
  const li = lineOf(raw({ id: "m1", from: "agent", label: "agent", text: "【main】好的喵" }))!;
  const own = lineOf(
    raw({
      id: "k1",
      from: "agent",
      label: "claude",
      text: "【claude】我来看",
      tokenLane: "claude",
    }),
  )!;
  const he = lineOf(raw({ id: "o1", from: "owner", text: "coco，看一下" }))!;

  it("reads agent and system lines: kind, sender (its shown name), the prefix gone", () => {
    expect(coco).toMatchObject({
      kind: "agent",
      sender: "coco",
      senderLane: "codex",
      text: "done, PR #12",
    });
    expect(sys).toMatchObject({ kind: "system", eventLane: "codex", text: "coco 开始实时监听" });
    expect(li).toMatchObject({ kind: "agent", sender: "Li", senderLane: "main" });
    expect(he.kind).toBeUndefined();
    // A friend lane with no known id: its token name.
    const f = lineOf(
      raw({ id: "f1", from: "agent", label: "otoji-main", text: "hi", tokenLane: "otoji-main" }),
    )!;
    expect(f).toMatchObject({ kind: "agent", sender: "otoji-main", senderLane: "otoji-main" });
    // Unnamed, unlabelled: no sender.
    expect(lineOf(raw({ id: "u1", from: "agent", label: "", text: "x" }))!.sender).toBeUndefined();
    // A state-tree line for another lane, the manager's token line: system.
    expect(
      lineOf(
        raw({
          id: "e1",
          from: "agent",
          label: "x",
          text: "ETA",
          source: "eta",
          eta: { lane: "agy" },
        }),
      )!.kind,
    ).toBe("system");
    expect(
      lineOf(raw({ id: "e2", from: "agent", label: "eta", agentId: "eta", text: "ETA" }))!.kind,
    ).toBe("system");
    // A routing test line stays a test line.
    expect(
      lineOf(raw({ id: "t1", from: "agent", label: "agent", text: "[lane-test] codex, hi" }))!.kind,
    ).toBeUndefined();
  });

  it("never its own: its own say, or a system line about itself", () => {
    expect(ownLine("claude", own)).toBe(true);
    expect(ownLine("chat", own)).toBe(true);
    expect(ownLine("codex", coco)).toBe(true);
    expect(ownLine("codex", sys)).toBe(true);
    expect(ownLine("claude", coco)).toBe(false);
    expect(ownLine("claude", sys)).toBe(false);
    expect(ownLine("claude", { kind: "system" })).toBe(false);
    expect(ownLine("claude", { kind: "agent" })).toBe(false);
    expect(ownLine("claude", he)).toBe(false);
    expect(everyoneTakes("claude", coco)).toBe(true);
    expect(everyoneTakes("claude", own)).toBe(false);
    expect(everyoneTakes("claude", he)).toBe(false);
    expect(everyoneTakes("claude", { ...coco, thread: "u-friend" })).toBe(false);
    expect(routeKey("claude")).toBe("chat");
    expect(routeKey("codex")).toBe("codex");
    expect(routeKey("main")).toBe("main");
    expect(routeKey("otoji-main")).toBe("otoji-main");
  });

  it("listenerTakes: his lines as before; --everyone adds agents and system; --skip-owner drops his", () => {
    const o = { lane: "codex", all: true };
    expect(listenerTakes(o, he)).toBe(true);
    expect(listenerTakes(o, li)).toBe(false);
    expect(listenerTakes({ ...o, everyone: true }, li)).toBe(true);
    expect(listenerTakes({ ...o, everyone: true }, sys)).toBe(false); // about itself
    expect(listenerTakes({ ...o, everyone: true }, coco)).toBe(false); // its own
    const k = { lane: "claude", all: true, everyone: true, skipOwner: true };
    expect(listenerTakes(k, he)).toBe(false);
    expect(listenerTakes(k, coco)).toBe(true);
    expect(listenerTakes(k, sys)).toBe(true);
    expect(listenerTakes(k, own)).toBe(false);
    // 小克 without --skip-owner: his unnamed lines route to it ("chat").
    expect(
      listenerTakes({ lane: "claude" }, lineOf(raw({ id: "o2", from: "owner", text: "在吗" }))!),
    ).toBe(true);
    // A state-tree nudge to the lane always.
    const nudge = lineOf(
      raw({
        id: "n1",
        from: "agent",
        label: "eta",
        text: "ETA",
        source: "eta",
        eta: { lane: "codex" },
      }),
    )!;
    expect(listenerTakes({ lane: "codex" }, nudge)).toBe(true);
    expect(briefBullet("codex", nudge)).toBe("- (state tree) ETA");
    expect(urgentLine("codex", nudge)).toBe(true);
  });

  it("the hand-off marks them 【agent · coco】 and 【系统】, FYI once, never urgent, never @你", () => {
    expect(briefBullet("claude", coco)).toBe(`- (id:c1) ${agentMark("coco")}done, PR #12`);
    expect(briefBullet("claude", sys)).toBe(`- (id:s1) ${SYSTEM_MARK}coco 开始实时监听`);
    expect(agentMark()).toBe("【agent · ?】");
    const named = lineOf(
      raw({ id: "c2", from: "agent", label: "codex", text: "小克，你来", tokenLane: "codex" }),
    )!;
    expect(urgentLine("claude", named)).toBe(false);
    expect(briefBullet("claude", named)).not.toContain("@你");
    expect(batchNotes("claude", [coco, sys])).toEqual([FYI_NOTE]);
    expect(batchNotes("claude", [he, coco])).toEqual([OTHER_NOTE, FYI_NOTE]);
    const b = handoffBrief("claude", [coco, sys], "/r", false);
    expect(b.split("\n")[0]).toStartWith("【chat → claude】");
    expect(b.match(new RegExp(FYI_NOTE, "g"))).toHaveLength(1);
    expect(handoffBrief("claude", [he, coco], "/r", false).split("\n")[0]).toStartWith(
      "【owner → claude】",
    );
    const long = handoff("claude", coco, "/r");
    expect(long).toStartWith(`${agentMark("coco")}(15:20 JST, Li chat) done, PR #12`);
    expect(long).toContain(FYI_NOTE);
    expect(handoff("claude", sys, "/r")).toStartWith(SYSTEM_MARK);
  });

  it("chunks stay under 800 characters with agent lines, the FYI note counted", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...coco,
      id: `c${i}`,
      text: "长".repeat(60),
    }));
    const parts = chunkLines("claude", many);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts)
      expect(handoffBrief("claude", p, "/r", false).length).toBeLessThanOrEqual(
        SEND_MAX_CHARS + 40,
      );
    const huge = chunkLines("claude", [{ ...coco, text: "x".repeat(2000) }]);
    expect(huge[0]![0]!.text.endsWith("…")).toBe(true);
    expect(briefBullet("claude", huge[0]![0]!).length + FYI_NOTE.length + 2).toBeLessThanOrEqual(
      SEND_MAX_CHARS,
    );
  });

  it("addressee knows 小克's token lane as the chat route", () => {
    expect(addressee("claude", "小克，看一下").to).toBe("mine");
    expect(addressee("claude", "coco，看一下").to).toBe("other");
  });
});

describe("makeDeliverer logs", () => {
  it("a held batch (LANE_LISTEN_DEBUG) and a lost one", async () => {
    const logs: Record<string, unknown>[] = [];
    const prev = process.env.LANE_LISTEN_DEBUG;
    process.env.LANE_LISTEN_DEBUG = "1";
    let busy = true;
    const d = makeDeliverer(
      { lane: "codex", repo: "/r" },
      async () => 1,
      async () => busy,
      (v) => void logs.push(v),
      1,
    );
    await d.add({ id: "q1", thread: "owner", from: "owner", text: "今天学了什么" });
    expect(logs.map((l) => l.type)).toEqual(["held"]);
    busy = false;
    await Bun.sleep(10);
    expect(logs.map((l) => l.type)).toEqual(["held", "delivered", "lost"]);
    if (prev === undefined) delete process.env.LANE_LISTEN_DEBUG;
    else process.env.LANE_LISTEN_DEBUG = prev;
  });
});

describe("makeDeliverer without a log", () => {
  it("still delivers", async () => {
    const sent: string[] = [];
    const d = makeDeliverer(
      { lane: "codex", repo: "/r" },
      async (b) => (sent.push(b), 0),
      async () => false,
    );
    expect(await d.add({ id: "q2", thread: "owner", from: "owner", text: "codex，在吗" })).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
