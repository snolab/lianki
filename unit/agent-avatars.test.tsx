/**
 * Agent avatars and presence (docs/dev-debug-widget.md, "Agent avatars", "Who
 * is here"): the SVG sanitizer, the generated mark, the presence list (join,
 * leave, window expiry, order, the stack's cap), the hub's `avatar` op (scope,
 * store, clear), the MCP badge, the owner's override and Remove (revoke closes
 * the socket), and the rendering.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DebugHub, type Socket, type Storage } from "@/workers/push/src/debug";
import { TOKEN_REFUSED, isMcpClient } from "@/workers/push/src/token-chat";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { createToken, type ScopeId } from "@/lib/api-tokens";
import { chatTokenCheck, type ChatTokenDb } from "@/lib/chat-token";
import { tokenApi } from "@/lib/api-token-api";
import {
  AVATAR_MAX_BYTES,
  autoMark,
  nameHash,
  sanitizeAvatarSvg,
} from "@/packages/debug-chat/src/svg-avatar";
import {
  type PartRecord,
  type Present,
  invitePrefill,
  nextExpiry,
  presenceSummary,
  presentList,
  stackOf,
} from "@/packages/debug-chat/src/presence";
import { lineAvatar } from "@/packages/debug-chat/src/avatar-rules";
import {
  LineTag,
  agentAvatar,
  autoAvatar,
  withTokenName,
} from "@/packages/debug-chat/src/LaneMark";
import { PresenceStack } from "@/packages/debug-chat/src/PresenceStack";
import { UI_EN } from "@/packages/debug-chat/src/ui-strings";
import type { ChatMessage } from "@/packages/debug-chat/src/wire";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-14T00:00:00Z");

describe("sanitizeAvatarSvg", () => {
  const ok = (raw: string) => {
    const r = sanitizeAvatarSvg(raw);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it("keeps a simple valid SVG (fresh markup, xmlns added)", () => {
    const r = ok(
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="oklch(0.6 0.13 200)"/><text x="12" y="16" text-anchor="middle" font-size="10">A&amp;B</text></svg>',
    );
    expect(r.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="oklch(0.6 0.13 200)"/><text x="12" y="16" text-anchor="middle" font-size="10">A&amp;B</text></svg>',
    );
    expect(r.dropped).toEqual([]);
    // Idempotent: what the page re-checks comes out the same.
    expect(ok(r.svg).svg).toBe(r.svg);
  });
  it("drops <script>, <foreignObject>, <image>, <use>, <style> with everything inside", () => {
    const r = ok(
      '<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><image href="https://x/y.png"/><use href="#a"/><style>*{fill:red}</style><rect width="10" height="10"/></svg>',
    );
    expect(r.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    );
    expect(r.dropped).toEqual(
      expect.arrayContaining(["<script>", "<foreignObject>", "<image>", "<use>", "<style>"]),
    );
    expect(r.svg).not.toMatch(/script|alert|href|foreign|image|style/i);
  });
  it("drops href, xlink:href, style, event handlers, url() and var() colours", () => {
    const r = ok(
      `<svg viewBox="0 0 10 10" onload="alert(1)"><a href="javascript:x"><path d="M0 0L10 10"/></a><path d="M0 0h10" xlink:href="https://evil" style="fill:red" onclick="x()" fill="url(#g)" stroke="var(--x)"/><circle r="2" fill="url(https://evil/x.svg#a)"/><rect width="1" height="1" fill="u&#114;l(#x)"/></svg>`,
    );
    expect(r.svg).not.toMatch(/href|style|onload|onclick|url|var\(|javascript|evil|alert/i);
    expect(r.svg).toContain('<path d="M0 0h10"/>');
  });
  it("refuses an SVG over the size cap, a DOCTYPE/ENTITY, CDATA, broken markup, a non-svg root", () => {
    const big = `<svg viewBox="0 0 1 1"><path d="${"M0 0".repeat(AVATAR_MAX_BYTES)}"/></svg>`;
    expect(sanitizeAvatarSvg(big)).toMatchObject({ ok: false });
    expect(
      sanitizeAvatarSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1">&x;</svg>'),
    ).toMatchObject({ ok: false });
    expect(sanitizeAvatarSvg('<svg viewBox="0 0 1 1"><![CDATA[x]]></svg>')).toMatchObject({
      ok: false,
    });
    expect(sanitizeAvatarSvg('<svg viewBox="0 0 1 1"><g></svg>')).toMatchObject({ ok: false });
    expect(sanitizeAvatarSvg("<html><body/></html>")).toMatchObject({ ok: false });
    expect(sanitizeAvatarSvg('<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>')).toMatchObject({
      ok: false,
    });
    expect(sanitizeAvatarSvg(42)).toMatchObject({ ok: false });
    expect(sanitizeAvatarSvg('<svg viewBox="0 0 1 1"><path d=M0/></svg>')).toMatchObject({
      ok: false,
    });
  });
  it("only the five XML entities and numeric ones in text", () => {
    expect(ok("<svg><title>a &lt; b &#65;</title></svg>").svg).toContain(
      "<title>a &lt; b A</title>",
    );
    expect(sanitizeAvatarSvg("<svg><title>&nbsp;</title></svg>")).toMatchObject({ ok: false });
  });
  it("gives a viewBox from width/height, else 0 0 24 24", () => {
    expect(ok('<svg width="48" height="32"/>').svg).toContain('viewBox="0 0 48 32"');
    expect(ok("<svg/>").svg).toContain('viewBox="0 0 24 24"');
  });
});

describe("autoMark: the same name, the same mark", () => {
  it("is deterministic and case/space-insensitive, oklch only", () => {
    expect(autoMark("mcp-bot")).toEqual(autoMark("mcp-bot"));
    expect(autoMark(" MCP-Bot ")).toEqual(autoMark("mcp-bot"));
    expect(nameHash("mcp-bot")).toBe(nameHash("mcp-bot"));
    const m = autoMark("mcp-bot");
    expect(m.bg).toMatch(/^oklch\(/);
    expect(m.fg).toMatch(/^oklch\(/);
    expect(m.paths.length).toBeGreaterThan(0);
  });
  it("spreads names over hues and glyphs", () => {
    const names = ["mcp-bot", "helper", "claude", "cursor", "my-mac", "ci", "deploy", "reader"];
    expect(new Set(names.map((n) => autoMark(n).bg)).size).toBeGreaterThan(4);
    expect(new Set(names.map((n) => JSON.stringify(autoMark(n).paths))).size).toBeGreaterThan(2);
  });
});

const rec = (tag: string, extra: Partial<PartRecord> = {}): PartRecord => ({
  tag,
  id: tag.padEnd(64, "0"),
  userId: "uOwner",
  thread: "owner",
  lane: `bot-${tag.slice(0, 2)}`,
  ...extra,
});
const line = (at: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: String(at),
  from: "agent",
  label: "x",
  text: "hi",
  at,
  ...extra,
});

describe("presentList", () => {
  const base = { readMs: 5 * MIN, speakerMs: 30 * MIN };
  it("join (socket), read window, recent speakers; most recent first", () => {
    const a = rec("a".repeat(16), { lane: "mcp-bot", mcp: true });
    const b = rec("b".repeat(16), { lane: "reader", seenAt: T0 - 2 * MIN });
    const list = presentList({
      ...base,
      now: T0,
      live: [{ tag: a.tag, at: T0 - 10 * MIN }],
      records: [a, b],
      lines: [line(T0 - MIN, { lane: "codex" }), line(T0 - 40 * MIN, { lane: "agy" })],
      viewer: "uOwner",
    });
    expect(list.map((p) => p.key)).toEqual(["lane:codex", `tok:${b.tag}`, `tok:${a.tag}`]);
    expect(list[2]).toMatchObject({ name: "mcp-bot", mcp: true, live: true, id: a.id });
    // agy spoke 40 min ago: past the speaker window.
    expect(list.some((p) => p.key === "lane:agy")).toBe(false);
  });
  it("leave: socket closed and the read window over", () => {
    const a = rec("a".repeat(16), { seenAt: T0 - 6 * MIN });
    expect(
      presentList({ ...base, now: T0, live: [], records: [a], lines: [], viewer: "uOwner" }),
    ).toEqual([]);
    // nextExpiry: when a read or a line leaves its window.
    expect(
      nextExpiry({
        ...base,
        now: T0,
        records: [rec("c".repeat(16), { seenAt: T0 - MIN })],
        lines: [line(T0 - 29 * MIN)],
      }),
    ).toBe(T0 + MIN);
  });
  it("token ids only for the viewer's own tokens; revoked tokens never listed", () => {
    const a = rec("a".repeat(16));
    const r = rec("d".repeat(16), { revoked: true, seenAt: T0 });
    const other = presentList({
      ...base,
      now: T0,
      live: [{ tag: a.tag, at: T0 }],
      records: [a, r],
      lines: [line(T0, { via: "token", tok: r.tag, tokenLane: "gone" })],
      viewer: "uSomeoneElse",
    });
    expect(other).toHaveLength(1);
    expect(other[0]!.id).toBeUndefined();
  });
  it("the owner's name and picture win over the agent's", () => {
    const a = rec("a".repeat(16), { lane: "bot", self: "1".repeat(64), seenAt: T0 });
    const [p0] = presentList({ ...base, now: T0, live: [], records: [a], lines: [] });
    expect(p0).toMatchObject({ name: "bot", avatar: "1".repeat(64), avatarBy: "agent" });
    const b = { ...a, ownerName: "Helper", ownerAvatar: "auto" };
    const [p1] = presentList({ ...base, now: T0, live: [], records: [b], lines: [] });
    expect(p1).toMatchObject({ name: "Helper", nameBy: "owner", avatarBy: "owner" });
    expect(p1!.avatar).toBeUndefined();
  });
  it("the stack shows the cap, then +N; the summary names them", () => {
    const list = ["agy", "codex", "mcp-bot", "x", "y"].map((name) => ({ name }));
    expect(stackOf(list, 3)).toEqual({ shown: list.slice(0, 3), more: 2 });
    expect(presenceSummary(list, 3)).toBe("agy, codex, mcp-bot +2");
    expect(presenceSummary(list.slice(0, 2), 3)).toBe("agy, codex");
  });
  it("the invite prefills a chat-only token form, nothing more", () => {
    expect(invitePrefill("?new-token=chat-agent")).toMatchObject({
      scopes: ["chat:read", "chat:write", "chat:ask"],
      days: 7,
    });
    expect(invitePrefill("?new-token=eval")).toBeNull();
  });
});

describe("MCP clients", () => {
  it("knows lianki mcp and the remote MCP by their header", () => {
    expect(isMcpClient("mcp/0.4.0 tool=lianki_chat_say")).toBe(true);
    expect(isMcpClient("mcp-remote/1.0.0 tool=lianki_chat_wait")).toBe(true);
    expect(isMcpClient("curl/8")).toBe(false);
    expect(isMcpClient(undefined)).toBe(false);
  });
});

// --- The hub ---------------------------------------------------------------------

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  readyState = 1;
  closed?: number;
  private att: unknown = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code;
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  lastPresent() {
    return (this.of("present").at(-1)?.list ?? []) as Present[];
  }
}

function fakeStorage(store = new Map<string, unknown>()): Storage {
  return {
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
    get: async <T,>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T,>({
      prefix,
      reverse,
      limit,
    }: {
      prefix: string;
      reverse?: boolean;
      limit?: number;
    }) => {
      let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

let d1: TestD1Database;
let t: number;
const db = () => d1 as unknown as ChatTokenDb;
const OWNER = { userId: "uOwner", email: "owner@example.com" };
const ALICE = { userId: "uAlice", email: "alice@example.com" };
const CHAT: ScopeId[] = ["chat:read", "chat:write", "chat:ask"];
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  d1 = createTestD1(testSchema());
  t = T0;
  const raw = d1.raw();
  for (const u of [OWNER, ALICE])
    raw
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-11-01', '2026-11-01')",
      )
      .run(u.userId, u.email);
  raw.prepare("DELETE FROM account_permission").run();
  raw
    .prepare(
      "INSERT INTO account_permission (email, permission, granted_by, granted_at) VALUES (?, 'dev', 'test', 1)",
    )
    .run(OWNER.email);
});

const mint = (who: typeof OWNER, name: string, scopes = CHAT) =>
  createToken(db(), who, { name, scopes, expiresAt: new Date(t + 30 * DAY) }, t);

function hubSetup() {
  const sockets: FakeSocket[] = [];
  const hub = new DebugHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage: fakeStorage(),
    },
    {
      SESSIONS: {
        live: async () => "gone",
        chatToken: (req: unknown) => chatTokenCheck(db(), req, t),
        config: async (key: string) => (key === "chat.presenceReadMin" ? 5 : undefined),
      },
    },
    () => t,
  );
  const http = async (token: string, body: unknown, client?: string) => {
    const r = await hub.fetch(
      new Request("https://lianki.com/api/version/chat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(client ? { "x-lianki-client": client } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const listen = async (token: string, client?: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    hub["tokens"].opened(ws, client);
    await hub.webSocketMessage(ws, JSON.stringify({ type: "auth", token }));
    await flush();
    return ws;
  };
  const ownerPage = async () => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await hub.connectPage(ws, new URL("https://lianki.com/api/version/debug?label=%2Fwords"), {
      ...OWNER,
      owner: true,
      session: "sess1",
      sessionUntil: t + DAY,
    });
    await flush();
    return ws;
  };
  return { hub, sockets, http, listen, ownerPage };
}

const SVG =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="oklch(0.6 0.1 120)"/></svg>';

describe("the hub: op avatar", () => {
  it("needs chat:write; stores the sanitized SVG once; lines carry its reference; clear", async () => {
    const h = hubSetup();
    const ro = await mint(OWNER, "reader", ["chat:read"]);
    expect((await h.http(ro.token, { op: "avatar", svg: SVG })).status).toBe(403);
    const w = await mint(OWNER, "mcp-bot");
    const bad = await h.http(w.token, { op: "avatar", svg: "<html/>" });
    expect(bad.status).toBe(400);
    const set = await h.http(w.token, {
      op: "avatar",
      svg: SVG.replace("<circle", '<script>x</script><circle onclick="x()"'),
    });
    expect(set.status).toBe(200);
    expect(set.body.avatar).toMatch(/^[0-9a-f]{64}$/);
    expect(set.body.dropped).toEqual(expect.arrayContaining(["<script>", "@onclick"]));
    // Served by reference, sanitized, never scripted.
    const g = await h.hub.fetch(
      new Request(`https://lianki.com/api/version/chat-avatar/${set.body.avatar}`),
    );
    expect(g.status).toBe(200);
    expect(g.headers.get("content-type")).toContain("image/svg+xml");
    const served = await g.text();
    expect(served).not.toMatch(/script|onclick/);
    expect(sanitizeAvatarSvg(served)).toMatchObject({ ok: true, svg: served });
    // A line from it carries the reference, never the markup, and the MCP badge.
    await h.http(w.token, { op: "say", text: "hello" }, "mcp/0.4.0 tool=lianki_chat_say");
    const hist = await h.hub.history("owner");
    const l = hist.at(-1)!;
    expect(l).toMatchObject({ avatar: set.body.avatar, client: "mcp", tok: w.id.slice(0, 16) });
    expect(JSON.stringify(l)).not.toContain("<svg");
    // Cleared: later lines have none.
    expect((await h.http(w.token, { op: "avatar", svg: null })).body).toMatchObject({
      ok: true,
      avatar: null,
    });
    await h.http(w.token, { op: "say", text: "again" });
    expect((await h.hub.history("owner")).at(-1)!.avatar).toBeUndefined();
    expect(
      (await h.hub.fetch(new Request("https://lianki.com/api/version/chat-avatar/zz"))).status,
    ).toBe(404);
  });
});

describe("the hub: presence pushed to the page", () => {
  it("join, read, leave by window expiry (alarm), the MCP badge", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint(OWNER, "mcp-bot");
    const ws = await h.listen(a.token, "mcp-remote/1.0.0 tool=lianki_chat_wait");
    expect(page.lastPresent()).toMatchObject([
      { name: "mcp-bot", live: true, mcp: true, id: a.id },
    ]);
    // A read only (no socket): present for the read window.
    const b = await mint(OWNER, "reader");
    t += MIN;
    await h.http(b.token, { op: "read" });
    await flush();
    expect(page.lastPresent().map((p) => p.name)).toEqual(["reader", "mcp-bot"]);
    // The socket closes: gone at once.
    ws.close(1000);
    await h.hub.webSocketClose(ws, 1000);
    await flush();
    expect(page.lastPresent().map((p) => p.name)).toEqual(["reader"]);
    // The read window passes: the alarm pushes the leave.
    t += 6 * MIN;
    await h.hub.alarm();
    await flush();
    expect(page.lastPresent()).toEqual([]);
  });

  it("the owner renames a token of his and sets its picture; not another account's", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const mine = await mint(OWNER, "bot");
    const theirs = await mint(ALICE, "alice-bot");
    await h.listen(mine.token);
    await h.http(theirs.token, { op: "say", text: "hi" });
    const tag = mine.id.slice(0, 16);
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: tag, name: "Helper", avatar: SVG }),
    );
    await flush();
    expect(page.of("participant-result").at(-1)).toMatchObject({ ok: true });
    expect(page.lastPresent()[0]).toMatchObject({
      name: "Helper",
      nameBy: "owner",
      avatarBy: "owner",
    });
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: theirs.id.slice(0, 16), name: "x" }),
    );
    expect(page.of("participant-result").at(-1)).toMatchObject({ ok: false });
    // An unsafe SVG from the page is sanitized the same way.
    await h.hub.webSocketMessage(
      page,
      JSON.stringify({ type: "participant", tok: tag, avatar: "<p/>" }),
    );
    expect(page.of("participant-result").at(-1)).toMatchObject({ ok: false });
  });

  it("Remove: /api/token DELETE of his own token closes its socket and drops it from the list", async () => {
    const h = hubSetup();
    const page = await h.ownerPage();
    const a = await mint(OWNER, "mcp-bot");
    const ws = await h.listen(a.token);
    expect(page.lastPresent()).toHaveLength(1);
    const notify = async (ids: string[]) => {
      await h.hub.fetch(
        new Request("https://lianki-push/internal/chat-tokens/revoked", {
          method: "POST",
          body: JSON.stringify({ tags: ids.map((i) => i.slice(0, 16)) }),
        }),
      );
    };
    const del = (who: typeof OWNER) =>
      tokenApi(
        new Request("https://lianki.com/api/token", {
          method: "DELETE",
          headers: { "content-type": "application/json", origin: "https://lianki.com" },
          body: JSON.stringify({ id: a.id }),
        }),
        {
          who: async () => who,
          db: () => d1 as unknown as D1Like & ChatTokenDb,
          revoked: notify,
          now: () => t,
        },
      );
    // Another account cannot.
    expect((await del(ALICE)).status).toBe(404);
    expect(ws.closed).toBeUndefined();
    expect((await del(OWNER)).status).toBe(200);
    expect(ws.closed).toBe(TOKEN_REFUSED);
    await h.hub.webSocketClose(ws, TOKEN_REFUSED);
    await flush();
    expect(page.lastPresent()).toEqual([]);
  });
});

describe("rendering", () => {
  it("a token line: the owner's name and picture first, else its own, else the generated mark", () => {
    const m = line(T0, {
      via: "token",
      tokenLane: "mcp-bot",
      tok: "a".repeat(16),
      avatar: "1".repeat(64),
    });
    const opts = { tokenAvatar: agentAvatar };
    const own = lineAvatar(m, opts);
    expect(own.name).toBe("mcp-bot");
    expect(renderToStaticMarkup(own.src as any)).toContain("debug-chat-auto-mark"); // while it loads
    const renamed = lineAvatar(m, {
      ...opts,
      participant: () => ({ name: "Helper" }),
    });
    expect(renamed.name).toBe("Helper");
    expect(renderToStaticMarkup(renamed.src as any)).toContain('data-name="Helper"');
    // Known lanes keep their marks.
    const codex = lineAvatar(line(T0, { lane: "codex" }), { laneAvatar: () => "lane" });
    expect(codex.src).toBe("lane");
  });
  it("the generated mark draws an oklch disc; the tag shows the MCP badge", () => {
    const html = renderToStaticMarkup(autoAvatar("mcp-bot"));
    expect(html).toContain(autoMark("mcp-bot").bg);
    const tag = renderToStaticMarkup(
      <LineTag m={{ via: "token", tokenLane: "mcp-bot", client: "mcp" }} name="mcp-bot" />,
    );
    expect(tag).toContain("mcp-bot");
    expect(tag).toContain('data-testid="debug-chat-mcp"');
    expect(renderToStaticMarkup(<LineTag m={{ via: "token", tokenLane: "x" }} />)).not.toContain(
      "MCP",
    );
    // Known lanes keep their tag, with the badge when MCP; main shows the host's name.
    const codex = renderToStaticMarkup(<LineTag m={{ lane: "codex", client: "mcp" }} />);
    expect(codex).toContain("codex");
    expect(codex).toContain("MCP");
    expect(renderToStaticMarkup(<LineTag m={{ lane: "main" }} agentName="Li" />)).toContain("Li");
    expect(renderToStaticMarkup(<LineTag m={{ lane: "main" }} />)).toBe("");
    expect(renderToStaticMarkup(<LineTag m={{ lane: "main", client: "mcp" }} inline />)).toContain(
      "MCP",
    );
    expect(renderToStaticMarkup(<LineTag m={{ via: "token" }} />)).toBe("");
    expect(renderToStaticMarkup(<LineTag m={{}} />)).toBe("");
  });
  it("a token line loses its 【name】 prefix in the log only", () => {
    const m = { via: "token", tokenLane: "mcp-bot", text: "【mcp-bot】 hello" };
    expect(withTokenName(m).text).toBe("hello");
    expect(withTokenName({ ...m, text: "plain" })).toEqual({ ...m, text: "plain" });
    const other = { text: "【mcp-bot】x" };
    expect(withTokenName(other)).toBe(other);
  });
  it("the stack: the cap, most recent first, +N", () => {
    const list: Present[] = ["agy", "codex", "mcp-bot", "x", "y"].map((name, i) => ({
      key: `k${i}`,
      name,
      active: 100 - i,
    }));
    const html = renderToStaticMarkup(
      <PresenceStack list={list} shown={3} t={UI_EN} mainName="Li" />,
    );
    expect(html.match(/debug-chat-presence-avatar/g)).toHaveLength(3);
    expect(html).toContain("+2");
    expect(html).toContain('aria-label="Who is here: agy, codex, mcp-bot +2"');
  });
});
