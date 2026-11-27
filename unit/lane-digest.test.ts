// Digest mode of lane-listen (docs/lane-listen.md, "Digest mode";
// scripts/dev/lane-digest-lib.ts): his consecutive lines are buffered and go as
// ONE digest (polished text + the original ids) to the chat lane always, and to
// a lane only when it is named in it. Synthetic line streams, timers by hand.
import { describe, expect, it } from "bun:test";
import {
  type Digest,
  type DigestInput,
  type DigestTimer,
  DEFAULT_FINAL_WORDS,
  digestFor,
  digestOn,
  digestOpts,
  digestRoute,
  digestText,
  endsFinal,
  makeDigester,
  tidy,
} from "../scripts/dev/lane-digest-lib";
import {
  DIGEST_CHAT_NOTE,
  DIGEST_NAMED_NOTE,
  type Line,
  SEND_MAX_CHARS,
  briefBullet,
  bypassLine,
  digestible,
  editOf,
  handoffBrief,
  lineOf,
  makeDeliverer,
  makeSeqCursor,
  routeKey,
  UNSURE_MARK,
  urgentLine,
  voiceAllowed,
} from "../scripts/dev/lane-listen-lib";
import type { RouteLane } from "../lib/lane-route";

process.env.LIANKI_OWNER_TZ = "Asia/Tokyo";

/** Timers that run only when the test moves the clock. */
function clock() {
  let now = 0;
  let n = 0;
  const q: { at: number; f: () => void; id: number }[] = [];
  const timer: DigestTimer = {
    set(f, ms) {
      q.push({ at: now + ms, f, id: ++n });
      return n;
    },
    clear(h) {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) q.splice(i, 1);
    },
  };
  return {
    timer,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const x = q[0];
        if (!x || x.at > end) break;
        q.shift();
        now = x.at;
        x.f();
        await Promise.resolve();
      }
      now = end;
    },
    pending: () => q.length,
  };
}

const OPTS = { pauseMs: 8_000, maxMs: 60_000, finalWords: [...DEFAULT_FINAL_WORDS] };
let seq = 100;
const spoken = (id: string, text: string): DigestInput => ({
  id,
  text,
  seq: ++seq,
  source: "stt",
  at: "2026-11-28T03:00:00.000Z",
});
const typed = (id: string, text: string): DigestInput => ({ id, text, seq: ++seq });

function setup() {
  const c = clock();
  const out: Digest[] = [];
  const d = makeDigester(OPTS, (x) => void out.push(x), c.timer);
  return { c, out, d };
}

describe("flush triggers", () => {
  it("pause: lines inside the pause go together; the pause restarts on each line", async () => {
    const { c, out, d } = setup();
    await d.add(spoken("a", "我想"));
    await c.advance(5_000);
    await d.add(spoken("b", "我想把这个改一下"));
    await c.advance(7_999);
    expect(out).toHaveLength(0);
    await c.advance(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("pause");
    expect(out[0]!.ids).toEqual(["a", "b"]);
    expect(c.pending()).toBe(0);
  });

  it("max window: speech that never pauses still flushes at maxMs after its first line", async () => {
    const { c, out, d } = setup();
    for (let i = 0; i < 20; i++) {
      await d.add(spoken(`m${i}`, `第${i}句`));
      await c.advance(4_000);
    }
    // 20 lines over 80 s, never an 8 s gap: one flush at 60 s, the rest buffering.
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("max");
    expect(out[0]!.ids).toEqual(Array.from({ length: 15 }, (_, i) => `m${i}`));
    expect(d.pending()).toBe(5);
    await c.advance(8_000);
    expect(out).toHaveLength(2);
    expect(out[1]!.ids[0]).toBe("m15");
  });

  it("a typed line flushes at once, together with the buffer", async () => {
    const { c, out, d } = setup();
    await d.add(spoken("s1", "嗯，那个首页"));
    await d.add(spoken("s2", "按钮太小了"));
    await d.add(typed("t1", "就这样改吧"));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("typed");
    expect(out[0]!.ids).toEqual(["s1", "s2", "t1"]);
    expect(c.pending()).toBe(0);
  });

  it("a line ending in a final word closes it at once", async () => {
    const { out, d } = setup();
    await d.add(spoken("f1", "把这个发出去"));
    await d.add(spoken("f2", "好，完毕"));
    expect(out.map((x) => x.reason)).toEqual(["final"]);
    expect(endsFinal("that's all, over.", ["over"])).toBe(true);
    expect(endsFinal("what a hangover", ["over"])).toBe(false);
  });
});

describe("ids and polish", () => {
  it("keeps every original id and seq, in order, covered lines too", async () => {
    const { c, out, d } = setup();
    await d.add(spoken("x1", "codex"));
    await d.add(spoken("x2", "看一下"));
    await d.add(spoken("x3", "那个 PR"));
    // The hub merged the three into one passage on x1 (an `edited` event).
    expect(d.edit({ id: "x1", text: "codex，看一下那个 PR。", covers: ["x1", "x2", "x3"] })).toBe(
      true,
    );
    await c.advance(8_000);
    const g = out[0]!;
    expect(g.ids).toEqual(["x1", "x2", "x3"]);
    expect(g.seqs.every((s) => typeof s === "number")).toBe(true);
    expect(g.text).toBe("codex，看一下那个 PR。");
    expect(g.lines.map((l) => l.raw)).toEqual(["codex", "看一下", "那个 PR"]);
  });

  it("tidy drops hesitations, fillers and stutters, not meaning", () => {
    expect(tidy("嗯，那个，我想改一下")).toBe("我想改一下");
    expect(tidy("um, I I think the the button is small")).toBe("I think the button is small");
    expect(tidy("我，我想")).toBe("我想");
    expect(tidy("那个按钮太小了")).toBe("那个按钮太小了");
    expect(tidy("就是这个")).toBe("就是这个");
  });

  it("digestText drops a fragment the next line repeats, and a line said twice", () => {
    const l = (id: string, text: string) => ({ id, text, raw: text, typed: false });
    expect(digestText([l("a", "我想"), l("b", "我想把首页改一下"), l("c", "按钮太小")])).toBe(
      "我想把首页改一下，按钮太小",
    );
    expect(digestText([l("a", "check the PR"), l("b", "check the PR"), l("c", "Then merge")])).toBe(
      "check the PR. Then merge",
    );
  });

  it("editOf reads the hub's edited event (passage ids as covers)", () => {
    const e = editOf(
      JSON.stringify({
        type: "edited",
        id: "p1",
        thread: "owner",
        text: "合并后的",
        passage: { ids: ["p1", "p2"] },
      }),
    );
    expect(e).toEqual({ id: "p1", text: "合并后的", thread: "owner", covers: ["p1", "p2"] });
    expect(editOf(JSON.stringify({ type: "chat", id: "x", text: "y" }))).toBeNull();
    expect(editOf("not json")).toBeNull();
  });

  it("real timers by default; flush() empties the buffer now and clears them", async () => {
    const got: Digest[] = [];
    const d = makeDigester(OPTS, (x) => void got.push(x));
    await d.add(spoken("r1", "hello"));
    expect(d.ids()).toEqual(["r1"]);
    await d.flush();
    expect(got.map((x) => x.ids)).toEqual([["r1"]]);
    expect(d.pending()).toBe(0);
    expect(await d.flush()).toBeUndefined();
  });

  it("lineOf keeps an owner line's source (stt or typed)", () => {
    const l = lineOf(
      JSON.stringify({
        type: "chat",
        message: { id: "a", from: "owner", text: "hi", source: "stt" },
      }),
    );
    expect(l?.source).toBe("stt");
    expect(digestible(l!)).toBe(true);
  });
});

describe("routing", () => {
  const line = (id: string, text: string, extra: Partial<Digest["lines"][number]> = {}) => ({
    id,
    text,
    raw: text,
    typed: false,
    ...extra,
  });
  const dg = (...lines: ReturnType<typeof line>[]): Digest => ({
    ids: lines.map((l) => l.id),
    seqs: lines.map(() => undefined),
    text: digestText(lines),
    lines,
    reason: "pause",
  });

  it("the chat lane gets every digest; a named lane only when named", () => {
    const ambient = dg(line("a", "今天天气不错"), line("b", "首页有点慢"));
    expect(digestRoute("chat", ambient)).toBe("chat");
    expect(digestRoute("codex", ambient)).toBeNull();
    expect(digestRoute("agy", ambient)).toBeNull();
    const named = dg(line("a", "首页有点慢"), line("b", "codex，你看一下"));
    expect(digestRoute("codex", named)).toBe("named");
    expect(digestRoute("agy", named)).toBeNull();
    expect(digestRoute("chat", named)).toBe("chat");
    const all = dg(line("a", "全体，报一下进度"));
    expect(digestRoute("codex", all)).toBe("named");
    expect(digestRoute("agy", all)).toBe("named");
  });

  it("a bypassed line does not count again; a voice the lane may not hear neither", () => {
    const d = dg(line("a", "@codex 停一下", { typed: true, bypass: true }), line("b", "没事了"));
    expect(digestRoute("codex", d)).toBeNull();
    const unsure = dg(line("a", "codex，看看", { voice: "unknown" }));
    expect(digestRoute("codex", unsure, (l) => l.voice !== "unknown")).toBeNull();
  });

  it("bypass: only a typed @name line for this lane", () => {
    const l = (text: string, source?: string): Line => ({
      id: "x",
      thread: "owner",
      from: "owner",
      text,
      ...(source ? { source } : {}),
    });
    expect(bypassLine("codex", l("@codex 停一下"))).toBe(true);
    expect(bypassLine("codex", l("@codex 停一下", "stt"))).toBe(false);
    expect(bypassLine("codex", l("codex，停一下"))).toBe(false);
    expect(bypassLine("agy", l("@codex 停一下"))).toBe(false);
  });

  it("a hand-off of a digest: one bullet with the ids, the polished text and the note", () => {
    const d = dg(line("a1", "嗯，首页有点慢"), line("a2", "codex，你看一下"));
    const l: Line = { id: "digest-a1", thread: "owner", from: "owner", text: d.text, digest: d };
    const toCodex = handoffBrief("codex", [l], "/repo", false);
    expect(toCodex).toContain("ids a1,a2");
    expect(toCodex).toContain("摘要·点名你");
    expect(toCodex).toContain("首页有点慢，codex，你看一下");
    expect(toCodex).toContain(DIGEST_NAMED_NOTE);
    const toChat = handoffBrief(routeKey("claude"), [l], "/repo", false);
    expect(toChat).toContain(DIGEST_CHAT_NOTE);
    expect(toChat).toContain("已转");
    expect(urgentLine("codex", l)).toBe(true);
    expect(briefBullet("codex", l).length).toBeLessThan(SEND_MAX_CHARS);
  });
});

/**
 * The whole path one listener runs (lane-listen.ts main, digest mode): every owner
 * line into the digester; each digest routed; a routed one handed to the deliverer.
 */
function lanePipe(lane: RouteLane) {
  const c = clock();
  const sent: string[] = [];
  const out = makeDeliverer(
    { lane, repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => false,
  );
  const d = makeDigester(
    OPTS,
    async (g) => {
      if (!digestRoute(lane, g)) return;
      await out.add({
        id: `digest-${g.ids[0]}`,
        thread: "owner",
        from: "owner",
        text: g.text,
        digest: g,
      });
    },
    c.timer,
  );
  return {
    c,
    sent,
    async line(l: DigestInput) {
      const full: Line = { thread: "owner", from: "owner", ...l };
      const bypass = lane !== "chat" && bypassLine(lane, full);
      if (bypass) await out.add(full);
      await d.add(l, { bypass });
    },
  };
}

describe("synthetic streams through the pipe", () => {
  const stream: DigestInput[] = [
    spoken("u1", "嗯，今天有点累"),
    spoken("u2", "首页那个按钮"),
    spoken("u3", "太小了"),
  ];

  it("unnamed lines never reach a lane; the chat lane gets one digest", async () => {
    const codex = lanePipe("codex");
    const agy = lanePipe("agy");
    const chat = lanePipe("chat");
    for (const l of stream) for (const p of [codex, agy, chat]) await p.line(l);
    for (const p of [codex, agy, chat]) await p.c.advance(8_000);
    expect(codex.sent).toEqual([]);
    expect(agy.sent).toEqual([]);
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toContain("ids u1,u2,u3");
  });

  it("a named lane gets the digest (with the ambient context), the other lane nothing", async () => {
    const codex = lanePipe("codex");
    const agy = lanePipe("agy");
    for (const l of [...stream, spoken("u4", "codex，你改一下")])
      for (const p of [codex, agy]) await p.line(l);
    for (const p of [codex, agy]) await p.c.advance(8_000);
    expect(agy.sent).toEqual([]);
    expect(codex.sent).toHaveLength(1);
    expect(codex.sent[0]).toContain("ids u1,u2,u3,u4");
    expect(codex.sent[0]).toContain("摘要·点名你");
  });

  it("a typed @name line goes to its lane at once, before any pause", async () => {
    const codex = lanePipe("codex");
    await codex.line(spoken("v1", "首页很慢"));
    await codex.line(typed("v2", "@codex 先停一下"));
    // At once: the line itself; the digest (typed flush) names codex only through the bypassed line.
    expect(codex.sent).toHaveLength(1);
    expect(codex.sent[0]).toContain("v2 点名你 @codex 先停一下");
  });
});

describe("options", () => {
  it("digest mode is on by default; --no-digest or LIANKI_LISTEN_DIGEST=0 turns it off", () => {
    expect(digestOn(undefined, {})).toBe(true);
    expect(digestOn(false, {})).toBe(false);
    expect(digestOn(undefined, { LIANKI_LISTEN_DIGEST: "0" })).toBe(false);
    expect(digestOn(undefined, { LIANKI_LANES_DIGEST: "false" })).toBe(false);
    expect(digestOn(true, { LIANKI_LISTEN_DIGEST: "0" })).toBe(true);
  });

  it("pause and max: defaults 8 s / 60 s, flags then env; a bad flag is an error", () => {
    expect(digestOpts({}, {})).toMatchObject({ pauseMs: 8_000, maxMs: 60_000 });
    expect(digestOpts({ pauseSec: "3" }, { LIANKI_LANES_DIGEST_PAUSE_SEC: "5" })).toMatchObject({
      pauseMs: 3_000,
    });
    expect(digestOpts({}, { LIANKI_LANES_DIGEST_MAX_SEC: "30" })).toMatchObject({ maxMs: 30_000 });
    expect(digestOpts({ pauseSec: "x" }, {})).toBeInstanceOf(Error);
    expect(digestOpts({}, { LIANKI_LANES_DIGEST_FINAL_WORDS: "收到, done" })).toMatchObject({
      finalWords: ["收到", "done"],
    });
  });
});

/**
 * lane-listen.ts's flush, recipient by recipient: the digest filtered by the lane's
 * own voice policy (voiceAllowed, as line by line), the dropped lines passed on the
 * cursor, the rest routed and handed over.
 */
function policyPipe(
  lane: RouteLane,
  policy: { everyone?: boolean },
  env: Record<string, string | undefined> = {},
) {
  const c = clock();
  const cursor = makeSeqCursor(200);
  const sent: string[] = [];
  const out = makeDeliverer(
    { lane, repo: "/repo" },
    async (body) => {
      sent.push(body);
      return 0;
    },
    async () => false,
    undefined,
    undefined,
    (lines, ok) => {
      if (ok) cursor.release(lines.flatMap((l) => (l.digest ? l.digest.seqs : [l.seq])));
    },
  );
  const allow = (x: Digest["lines"][number]) =>
    voiceAllowed({ from: "owner", voice: x.voice }, policy, env);
  const d = makeDigester(
    OPTS,
    async (whole) => {
      const { digest, passed } = digestFor(whole, allow);
      cursor.release(passed);
      const to = digest ? digestRoute(lane, digest) : null;
      if (!digest || !to) {
        cursor.release(digest?.lines.map((x) => x.seq) ?? []);
        return;
      }
      await out.add({
        id: `digest-${digest.ids[0]}`,
        thread: "owner",
        from: "owner",
        text: digest.text,
        digest,
      });
    },
    c.timer,
  );
  return {
    c,
    d,
    sent,
    cursor,
    async line(l: DigestInput) {
      cursor.hold(l.seq);
      await d.add(l);
    },
  };
}

const said = (id: string, n: number, text: string, voice?: string): DigestInput => ({
  id,
  text,
  seq: n,
  source: "stt",
  ...(voice ? { voice } : {}),
});

describe("each recipient sees only what its voice policy allows", () => {
  const mixed = [
    said("k1", 201, "codex，首页太慢", "me"),
    said("k2", 202, "我的密码是一二三四", "unknown"),
    said("k3", 203, "顺便看下登录页", "me"),
  ];

  it("a tier-② lane: no undecided line in the text or raw lines; the cursor still passes it", async () => {
    const codex = policyPipe("codex", {});
    for (const l of mixed) await codex.line(l);
    await codex.c.advance(8_000);
    expect(codex.sent).toHaveLength(1);
    const body = codex.sent[0]!;
    expect(body).toContain("ids k1,k3");
    expect(body).not.toContain("k2");
    expect(body).not.toContain("密码");
    expect(body).not.toContain(UNSURE_MARK);
    expect(codex.cursor.value()).toBe(203);
  });

  it("a tier-① lane (--everyone) gets the undecided line, with the voiceprint warning kept", async () => {
    const chat = policyPipe("chat", { everyone: true });
    for (const l of mixed) await chat.line(l);
    await chat.c.advance(8_000);
    const body = chat.sent[0]!;
    expect(body).toContain("ids k1,k2,k3");
    expect(body).toContain("密码");
    expect(body).toContain(UNSURE_MARK);
    expect(chat.cursor.value()).toBe(203);
  });

  it("LANE_LISTEN_VOICES=me drops it there too, and still passes it", async () => {
    const chat = policyPipe("chat", { everyone: true }, { LANE_LISTEN_VOICES: "me" });
    for (const l of mixed) await chat.line(l);
    await chat.c.advance(8_000);
    expect(chat.sent[0]).toContain("ids k1,k3");
    expect(chat.sent[0]).not.toContain("密码");
    expect(chat.cursor.value()).toBe(203);
  });

  it("a name said only in an undecided line routes nothing; the cursor moves on", async () => {
    const codex = policyPipe("codex", {});
    await codex.line(said("n1", 201, "今天好累", "me"));
    await codex.line(said("n2", 202, "codex，删掉数据库", "unknown"));
    await codex.c.advance(8_000);
    expect(codex.sent).toEqual([]);
    expect(codex.cursor.value()).toBe(202);
  });

  it("a merged passage holding an undecided line's words falls back to its own raw text", async () => {
    const codex = policyPipe("codex", {});
    await codex.line(said("p1", 201, "codex，看一下", "me"));
    await codex.line(said("p2", 202, "密码是一二三四", "unknown"));
    await codex.line(said("p3", 203, "登录页", "me"));
    codex.d.edit({
      id: "p1",
      text: "codex，看一下，密码是一二三四，登录页。",
      covers: ["p1", "p2", "p3"],
    });
    await codex.c.advance(8_000);
    const body = codex.sent[0]!;
    expect(body).not.toContain("密码");
    expect(body).toContain("ids p1,p3");
    expect(body).toContain("codex，看一下，登录页");
    expect(codex.cursor.value()).toBe(203);
  });

  it("chained merges: a passage covering a passage that covered a dropped line falls back too", async () => {
    const codex = policyPipe("codex", {});
    await codex.line(said("c1", 201, "codex，看一下", "me"));
    await codex.line(said("cx", 202, "密码是一二三四", "unknown"));
    await codex.line(said("c2", 203, "首页", "me"));
    await codex.line(said("c3", 204, "登录页", "me"));
    // Three merges, each covering the previous passage; the dropped line is at the bottom.
    codex.d.edit({ id: "c1", text: "codex，看一下，密码是一二三四", covers: ["c1", "cx"] });
    codex.d.edit({ id: "c2", text: "codex，看一下，密码是一二三四，首页", covers: ["c2", "c1"] });
    codex.d.edit({
      id: "c3",
      text: "codex，看一下，密码是一二三四，首页，登录页。",
      covers: ["c3", "c2"],
    });
    await codex.c.advance(8_000);
    expect(codex.sent).toHaveLength(1);
    const body = codex.sent[0]!;
    expect(body).not.toContain("密码");
    expect(body).not.toContain("cx");
    expect(body).toContain("ids c1,c2,c3");
    expect(body).toContain("codex，看一下，首页，登录页");
    expect(codex.cursor.value()).toBe(204);
    // A lane that may hear it keeps the chain's merged passage as it is.
    const chat = policyPipe("chat", { everyone: true });
    for (const l of [
      said("c1", 201, "codex，看一下", "me"),
      said("cx", 202, "密码是一二三四", "unknown"),
      said("c2", 203, "首页", "me"),
    ])
      await chat.line(l);
    chat.d.edit({ id: "c1", text: "codex，看一下，密码是一二三四", covers: ["c1", "cx"] });
    chat.d.edit({ id: "c2", text: "codex，看一下，密码是一二三四，首页。", covers: ["c2", "c1"] });
    await chat.c.advance(8_000);
    expect(chat.sent[0]).toContain("codex，看一下，密码是一二三四，首页。");
    expect(chat.cursor.value()).toBe(203);
  });

  it("digestFor restores the allowed lines' raw text with their own seqs, in seq order", () => {
    const L = (id: string, seq: number, raw: string, extra: object = {}) => ({
      id,
      seq,
      text: raw,
      raw,
      typed: false,
      ...extra,
    });
    // Buffer order differs from seq order; the top passage (b3) holds everything.
    const lines = [
      L("b3", 304, "登录页", { text: "看一下，秘密，首页，登录页", covers: ["b2"] }),
      L("b1", 301, "看一下", { text: "看一下，秘密", covers: ["bx"], covered: true }),
      L("bx", 302, "秘密", { voice: "unknown", covered: true }),
      L("b2", 303, "首页", { text: "看一下，秘密，首页", covers: ["b1"], covered: true }),
    ];
    const d: Digest = {
      ids: lines.map((l) => l.id),
      seqs: lines.map((l) => l.seq),
      text: "看一下，秘密，首页，登录页",
      lines,
      reason: "pause",
    };
    const { digest, passed } = digestFor(d, (l) => l.voice !== "unknown");
    expect(passed).toEqual([302]);
    expect(digest!.ids).toEqual(["b1", "b2", "b3"]);
    expect(digest!.seqs).toEqual([301, 303, 304]);
    expect(digest!.lines.map((l) => l.text)).toEqual(["看一下", "首页", "登录页"]);
    expect(digest!.lines.some((l) => l.covered || l.covers)).toBe(false);
    expect(digest!.text).toBe("看一下，首页，登录页");
  });

  it("digestFor leaves an all-allowed digest as it is, and returns nothing when all are dropped", () => {
    const lines = [{ id: "a", seq: 1, text: "x", raw: "x", typed: false, voice: "unknown" }];
    const d: Digest = { ids: ["a"], seqs: [1], text: "x", lines, reason: "pause" };
    expect(digestFor(d, () => true)).toEqual({ digest: d, passed: [] });
    expect(digestFor(d, () => false)).toEqual({ digest: null, passed: [1] });
  });
});
