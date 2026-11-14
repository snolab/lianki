/**
 * The state tree's hub (docs/state-tree.md): live progress for the owner's
 * /dev/roadmap. Separate from the debug chat (debug.ts): its own Durable
 * Object, its own routes, its own secret.
 *
 *   writers   Nodes' assignees, through scripts/dev/progress.ts, with
 *             `Authorization: Bearer <token>`: PROGRESS_TOKEN itself (the
 *             root: anywhere) or a scoped token (lib/progress-token.ts: one
 *             node and its subtree). index.ts refuses browsers and answers 503
 *             while the secret is unset; the hub checks the token and the scope.
 *   readers   The owner's /dev/roadmap pages, over a hibernatable WebSocket.
 *             index.ts lets one through only from a lianki.com page whose
 *             cookie the main Worker names the owner (as the debug chat does)
 *             and says so in x-progress-owner. The same socket checks off his
 *             to-dos ({type:"resolve", id}). Any valid token may also read
 *             the whole tree as JSON (GET).
 *   the box   The owner's box (docs/box-oauth.md, "Chat on the owner's box"):
 *             cookie-less, so index.ts lets its socket through on a box chat
 *             ticket alone, from the box origin it names, and says which box
 *             in x-progress-box. The hub burns the ticket once and asks the
 *             main Worker (DebugSessions.boxChat) at connect, again before
 *             anything is sent to it once BOX_RECHECK_MS has passed, and
 *             before each {type:"eta"} it sends. "gone" closes it (4401);
 *             unsure skips that message. It reads and pings, never resolves.
 *
 * Every write is an event ({type:"progress", ...node}). State is the latest
 * node per `id` (one storage key each), so a reload sees where everything
 * stands, plus an append-only log of the last PROGRESS_LOG_MAX events (one key
 * each, in order). Each event goes to every reader. A done node is pruned
 * PROGRESS_DONE_TTL_MS after its last write by the Durable Object alarm — no
 * timers, no polling — and auto-created groups left empty go with it. At most
 * PROGRESS_MAX_ENTRIES are kept; past that the oldest done nodes go first.
 *
 * Each task that goes done also leaves one record ({agent, id, title,
 * estimateMs, actualMs, revisions}) in a durable stats log (keys "d:", the
 * newest PROGRESS_STATS_MAX, PROGRESS_STATS_TTL_MS), read with GET /stats
 * (`progress.ts stats`) by agents calibrating their ETAs; never sent to pages.
 *
 * And one record per done node ({id, title, agent, prs, link, endedAt…}) in
 * the durable done history (keys "h:", one per id, no expiry): what
 * /dev/roadmap lists as done after the live tree drops the node. Read with
 * GET /history (`progress.ts history`) or, by a reader, {type:"history"} on
 * its socket (answered to that socket only). Records from before the history
 * existed come once from the stats log (HISTORY_MIGRATED).
 *
 * Writers are rate limited per name and in total, in memory: an evicted hub
 * starts a fresh window, which is fine for a limit meant to stop a runaway loop.
 */
import {
  OWNER_NAME,
  PROGRESS_AUTO,
  PROGRESS_DONE_TTL_MS,
  PROGRESS_ETA_MAX_MS,
  PROGRESS_HISTORY_SEND_DEFAULT,
  PROGRESS_LIMITS,
  PROGRESS_LOG_MAX,
  PROGRESS_MAX_ENTRIES,
  PROGRESS_STATS_MAX,
  PROGRESS_STATS_TTL_MS,
  type ProgressDone,
  type ProgressEntry,
  type ProgressEvent,
  type ProgressHistory,
  type ProgressHistoryMessage,
  type ProgressMessage,
  type ProgressReport,
  autoNode,
  blockedOn,
  checkTaskTitle,
  historyFromDone,
  newReceiptCode,
  RECEIPT_RE,
  titleName,
  verifyIdOf,
  historyKey,
  isOwnerTodo,
  isPathId,
  isProgressId,
  mergeProgress,
  newChangeId,
  newestHistory,
  parseProgressReport,
  parseTtl,
  pathParent,
  progressDone,
  progressEvent,
  progressHistory,
  progressKey,
  progressAgo,
} from "../../../lib/progress";
import {
  type ProgressAuth,
  mintProgressToken,
  verifyProgressToken,
} from "../../../lib/progress-token";
import type { Socket, Storage } from "./debug";
import { PARTNER_SUBPROTOCOL, STT_TICKET_SKEW_S } from "../../../lib/stt-ticket";
import { ETA_HEARD_PATH, ETA_PATH, type EtaPing } from "../../../lib/eta-ping";
import {
  ETA_NUDGE_KEYS,
  NUDGE_DEFAULTS,
  type NudgeRules,
  backoffDelayMs,
  holdTransition,
  holdsEta,
  nudgeDue,
  nudgeRules,
} from "../../../lib/eta-nudge";
import {
  OWNER_WAIT_REMIND_KEY,
  ownerWaitTransition,
  ownerWaits,
  parseRemindDays,
  remindDelayMs,
  remindDue,
} from "../../../lib/owner-wait";

export type ProgressState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: Storage;
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

/** Set by index.ts after the owner check; never trusted from the client. */
export const PROGRESS_OWNER_HEADER = "x-progress-owner";
/** Set by index.ts from a verified box chat ticket: the box's client id. Never from the client. */
export const PROGRESS_BOX_HEADER = "x-progress-box";
/** Set by index.ts with the box header: the ticket's `<jti>.<exp>`, burned here once. */
export const PROGRESS_TICKET_HEADER = "x-progress-ticket";
/** The box's socket closed because its box lost box:chat (as the chat hub's BOX_CLOSED). */
export const PROGRESS_BOX_CLOSED = 4401;
/** A box reader's binding is read again before a send once this long has passed. */
export const BOX_RECHECK_MS = 30_000;
/** The main Worker's box check (worker.ts DebugSessions): "live" | "gone" | "busy". */
type BoxRpc = {
  boxChat?(clientId: string): Promise<unknown>;
  /**
   * An API token's check (lib/chat-token.ts chatTokenCheck, op "progress"):
   * the `progress` permission, expiry, account, and whether that account is
   * the site owner's (holds `dev`). The hub never sees the token's row.
   */
  chatToken?(req: { op: string; token?: string; client?: string }): Promise<unknown>;
  /** A config value (lib/config.ts key); the reminder spacing for nodes waiting on the owner. */
  config?(key: string): Promise<unknown>;
};
/** A box reader's attachment: which box, and when its binding was last found live. */
type BoxReader = { box: string; checked: number };
const boxOf = (ws: Socket): BoxReader | null => {
  try {
    const a = ws.deserializeAttachment() as Partial<BoxReader> | null;
    return a && typeof a.box === "string" ? { box: a.box, checked: Number(a.checked) || 0 } : null;
  } catch {
    return null;
  }
};
/** Writes allowed per window: per name, and for everyone together. */
export const RATE = { windowMs: 60_000, perName: 30, total: 120 } as const;
/** A report is a few hundred bytes; anything much bigger is not one. */
export const MAX_BODY = 4096;
/** A batch (POST /batch): at most this many reports, in at most this many bytes. */
export const BATCH_MAX = 20;
export const MAX_BATCH_BODY = BATCH_MAX * MAX_BODY;
/**
 * A change id given on separate calls (`--change-id`) keeps the time of its
 * first write for this long, so the ticks of one action line up on the Gantt.
 */
export const CHANGE_ID_WINDOW_MS = 10 * 60_000;
const CHANGE = "cid:";
/** The longest a minted token lives. */
export const GRANT_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const GRANT_DEFAULT = "8h";
/**
 * ETA pings (docs/state-tree.md, "ETA pings"). A page's {type:"eta", id} is
 * taken this long before the hub's own clock says it is due (clocks differ).
 */
export const ETA_SKEW_MS = 5_000;
/** A ping the chat hub could not take is tried again this much later… */
export const ETA_RETRY_MS = 60_000;
/** …until it is this late; then it is dropped (marked sent). */
export const ETA_GIVE_UP_MS = 60 * 60 * 1000;
/** The receipt, backoff and verify rules (config keys) are read again after this long. */
export const RULES_CACHE_MS = 30_000;

type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
};

/** The note a check-off writes. */
export const RESOLVED_NOTE = "resolved by owner";

const PREFIX = "e:";
/** The main Worker tells lianki-push a box lost box:chat (index.ts hands it here too). */
export const BOX_CLOSED_PATH = "/internal/box-closed";
/** A ticket's clock allowance, as the chat hub's. */
const TICKET_SKEW_MS = STT_TICKET_SKEW_S * 1000;
/** Log keys sort in the order the events happened: time, then a sequence number. */
const LOG = "l:";
const logKey = (at: number, seq: number, prefix = LOG) =>
  `${prefix}${String(at).padStart(15, "0")}:${String(seq).padStart(6, "0")}`;
/** The stats log: one record per task that went done, kept PROGRESS_STATS_TTL_MS. */
const DONE = "d:";
/** The done history: one record per done node (historyKey), kept with no expiry. */
const HISTORY = "h:";
/** Set once the stats log's records were copied into the history. */
export const HISTORY_MIGRATED = "hmig";

/**
 * The checks index.ts makes before a token route reaches the hub. null = go
 * on; otherwise the response. 403 from a browser (pages never use tokens),
 * 503 while the secret is unset (so a writer sees why), 401 with no bearer.
 */
export function progressGate(req: Request, secret: string | undefined): Response | null {
  if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
  if (!secret)
    return new Response("the state tree is not configured (PROGRESS_TOKEN unset)", { status: 503 });
  if (!/^Bearer \S+$/.test(req.headers.get("authorization") ?? ""))
    return new Response("unauthorized", { status: 401 });
  return null;
}

/** An API token (lib/api-tokens.ts TOKEN_RE): checked by the main Worker, not by the root secret. */
const API_TOKEN_RE = /^lk_[0-9a-f]{64}$/;

/** Whose writes a token's are, for the rate window: the owner's, or the agent it acts as. */
const who = (auth: ProgressAuth) => (auth.root ? (auth.agent ?? OWNER_NAME) : auth.agent);

/**
 * A report as an API token sends it: without an agent, it is the token's
 * (the hub fills it in); naming another one is refused in `refuse`.
 */
function asAgent(auth: ProgressAuth, raw: unknown): unknown {
  if (!auth.root || !auth.agent || !raw || typeof raw !== "object" || Array.isArray(raw))
    return raw;
  const b = raw as Record<string, unknown>;
  return b.agent === undefined && b.assignee === undefined ? { ...b, agent: auth.agent } : raw;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, status);

/**
 * An open node whose estimate has not been pinged yet. A ping queued for want
 * of a listener waits for one (ETA_HEARD_PATH), not for the alarm, unless
 * `queued` says this is that call.
 */
const etaDue = (e: ProgressEntry, queued = false) =>
  e.etaAt !== undefined && e.etaSent !== e.etaAt && (queued || e.etaQueued !== e.etaAt);
/** Pinged and heard at this estimate, open, not held (lib/eta-nudge.ts holdsEta). */
const pinged = (e: ProgressEntry) =>
  e.status !== "done" && !holdsEta(e) && e.etaAt !== undefined && e.etaSent === e.etaAt;
/** When the receipt clock started: the line was heard (older pings: their etaAt). */
const heardAt = (e: ProgressEntry) => e.etaHeardAt ?? e.etaAt!;
/**
 * Receipts (docs/state-tree.md, "Receipts"): pinged, not acked, the
 * coordinating lane not told, the owner not told: due rules.ackMs after it was heard.
 */
const mainAt = (e: ProgressEntry, r: NudgeRules) =>
  pinged(e) &&
  e.etaCode !== undefined &&
  e.etaAcked !== e.etaAt &&
  e.etaMain !== e.etaAt &&
  e.etaSilent !== e.etaAt
    ? heardAt(e) + r.ackMs
    : undefined;
/**
 * Pinged, still at that estimate (no new one), and the owner not yet told it
 * went unexplained (docs/state-tree.md, "ETA overrun"): due ackMs + ownerMs
 * after the line was heard.
 */
const silentAt = (e: ProgressEntry, r: NudgeRules) =>
  pinged(e) && e.etaSilent !== e.etaAt ? heardAt(e) + r.ackMs + r.ownerMs : undefined;
/** Told it went unexplained, still not explained: the next repeat (backoff), if one is set. */
const repeatAt = (e: ProgressEntry) =>
  pinged(e) && e.etaSilent === e.etaAt ? e.silentAt : undefined;
const MIN_MS = 60_000;

/**
 * A node as the API and the readers get it: with `etaConfirmedAgo` ("5 min
 * ago"), when its estimate was last set or re-confirmed (etaConfirmedAt), so a
 * coordinator spots a stale one at a glance.
 */
export function withAgo<T extends ProgressEntry | ProgressEvent>(e: T, now: number): T {
  return e.etaConfirmedAt === undefined
    ? e
    : { ...e, etaConfirmedAgo: progressAgo(e.etaConfirmedAt, now) };
}

/** A logged event without the node's ETA history (the node itself carries it). */
const lean = (ev: ProgressEvent): ProgressEvent => {
  const { etaEvents: _events, ...rest } = ev;
  return rest;
};

export class ProgressHub {
  private windows = new Map<string, { start: number; count: number }>();
  private seq = 0;
  private secret: string | undefined;
  /** The chat hub (debug.ts), where an ETA ping becomes a line in the owner's thread. */
  private debug: Namespace | undefined;
  /** Nodes whose ping is being sent right now (fireEta): a second caller backs off at once. */
  private firing = new Set<string>();
  /** The main Worker's DebugSessions RPC: whether a box may still read (box readers only). */
  private sessions: BoxRpc | undefined;

  constructor(
    private ctx: ProgressState,
    env?: { PROGRESS_TOKEN?: string; DEBUG?: Namespace; SESSIONS?: BoxRpc },
    private now: () => number = Date.now,
  ) {
    this.secret = env?.PROGRESS_TOKEN;
    this.debug = env?.DEBUG;
    this.sessions = env?.SESSIONS;
  }

  /** The main Worker's word on a box: "live", "gone", or "unsure". No check there counts as gone. */
  private async boxSays(box: string): Promise<"live" | "gone" | "unsure"> {
    // Called on the stub itself: a .bind-ed RPC method is refused.
    const rpc = this.sessions;
    try {
      if (!rpc?.boxChat) return "gone";
      const said = await rpc.boxChat(box);
      return said === "live" || said === "gone" ? said : "unsure";
    } catch (e) {
      console.log(
        JSON.stringify({ msg: "progress.box-check-failed", error: String(e).slice(0, 200) }),
      );
      return "unsure";
    }
  }

  /**
   * May this box reader be sent to (or heard) now? Re-read when `fresh` or its
   * last check is older than BOX_RECHECK_MS. "gone" closes it.
   */
  private async boxMay(ws: Socket, r: BoxReader, fresh = false): Promise<boolean> {
    const t = this.now();
    if (!fresh && t - r.checked < BOX_RECHECK_MS) return true;
    const said = await this.boxSays(r.box);
    if (said === "live") {
      try {
        ws.serializeAttachment({ box: r.box, checked: t } satisfies BoxReader);
      } catch {}
      return true;
    }
    if (said === "gone") {
      console.log(JSON.stringify({ msg: "progress.box-closed", why: "check" }));
      try {
        ws.close(PROGRESS_BOX_CLOSED, "box chat ended");
      } catch {}
    }
    return false;
  }

  /** A box chat ticket (`<jti>.<exp>`, from index.ts) opens one progress socket, once. */
  private async burnTicket(raw: string | null): Promise<boolean> {
    if (!raw) return false;
    const at = raw.lastIndexOf(".");
    const jti = raw.slice(0, at);
    const exp = Number(raw.slice(at + 1));
    const t = this.now();
    if (at <= 0 || !/^[A-Za-z0-9_-]{8,64}$/.test(jti) || !Number.isFinite(exp)) return false;
    if (exp * 1000 + TICKET_SKEW_MS < t) return false;
    const key = `pjti:${jti}`;
    if ((await this.ctx.storage.get<number>(key)) !== undefined) return false;
    await this.ctx.storage.put(key, exp);
    const old = await this.ctx.storage.list<number>({ prefix: "pjti:", limit: 200 });
    for (const [k, e] of old) if (e * 1000 + TICKET_SKEW_MS < t) await this.ctx.storage.delete(k);
    return true;
  }

  /** The owner's box: a ticket socket, checked at connect (see the header). */
  private async connectBox(req: Request): Promise<Response> {
    const box = req.headers.get(PROGRESS_BOX_HEADER) ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(box)) return new Response("forbidden", { status: 403 });
    if (!(await this.burnTicket(req.headers.get(PROGRESS_TICKET_HEADER))))
      return new Response("forbidden", { status: 403 });
    if ((await this.boxSays(box)) !== "live") return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ box, checked: this.now() } satisfies BoxReader);
    await this.sendSnapshot([pair[1]]);
    // The browser fails a socket whose offered subprotocol is not selected.
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": PARTNER_SUBPROTOCOL },
    } as ResponseInit);
  }

  /** POST /internal/box-closed {client}: that box lost box:chat; its readers close now. */
  private async boxClosed(req: Request): Promise<Response> {
    let client: unknown;
    try {
      client = ((await req.json()) as { client?: unknown }).client;
    } catch {}
    if (typeof client !== "string" || !client) return fail(400, "expected {client}");
    let closed = 0;
    for (const ws of this.ctx.getWebSockets())
      if (boxOf(ws)?.box === client) {
        try {
          ws.close(PROGRESS_BOX_CLOSED, "box chat ended");
        } catch {}
        closed++;
      }
    console.log(JSON.stringify({ msg: "progress.box-closed", why: "notice", closed }));
    return json({ ok: true, closed });
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (req.headers.has(PROGRESS_BOX_HEADER)) return this.connectBox(req);
      if (req.headers.get(PROGRESS_OWNER_HEADER) !== "1")
        return new Response("forbidden", { status: 403 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      await this.sendSnapshot([pair[1]]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    // Reached only over the binding (index.ts checks the internal hostname).
    if (path === BOX_CLOSED_PATH && req.method === "POST") return this.boxClosed(req);
    if (path === ETA_HEARD_PATH && req.method === "POST") return this.heard();
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const auth = API_TOKEN_RE.test(token)
      ? await this.apiTokenAuth(token, req.headers.get("x-lianki-client"))
      : this.secret
        ? await verifyProgressToken(this.secret, token, this.now())
        : null;
    if (auth instanceof Response) return auth;
    if (!auth) return fail(401, "unauthorized (wrong, forged or expired token)");
    if (req.method === "GET") {
      if (path.endsWith("/stats")) return json({ done: await this.doneLog() });
      if (path.endsWith("/history"))
        return json(await this.historyAnswer(Number(new URL(req.url).searchParams.get("limit"))));
      return json(await this.state());
    }
    if (req.method !== "POST") return fail(405, "GET or POST");
    const body = await this.body(req);
    if (body instanceof Response) return body;
    if (path.endsWith("/grant")) return this.grant(auth, body);
    if (path.endsWith("/batch")) return this.batch(auth, body);
    if (path.endsWith("/ack")) return this.ack(auth, body);
    if (path.endsWith("/resolve")) {
      if (!auth.root) return fail(403, "only the owner (the root token) resolves");
      const b = body as { id?: unknown; note?: unknown };
      if (!isProgressId(b.id)) return fail(400, "id is required");
      const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : RESOLVED_NOTE;
      return this.resolve(b.id, note.slice(0, PROGRESS_LIMITS.note));
    }
    const report = parseProgressReport(asAgent(auth, body));
    if (report instanceof Error) return fail(400, report.message);
    return this.write(auth, report);
  }

  /**
   * An API token (`lk_…`) holding the `progress` permission (lib/api-tokens.ts;
   * `lianki progress`, the progress_* MCP tools): the main Worker checks it
   * (DebugSessions.chatToken, op "progress") — the permission, its expiry, its
   * account, and that the account is the site owner's. It is then the root
   * grant acting as the token's name (ProgressAuth, `agent`): every report is
   * that agent's, across the whole tree. The token is never logged; a refusal
   * names only why. 503 when the main Worker cannot be asked.
   */
  private async apiTokenAuth(
    token: string,
    client: string | null,
  ): Promise<ProgressAuth | Response> {
    const rpc = this.sessions;
    if (!rpc?.chatToken) return fail(503, "API tokens are not accepted here yet");
    let a: { ok?: unknown; error?: unknown; owner?: unknown; lane?: unknown } | null;
    try {
      a = (await rpc.chatToken({
        op: "progress",
        token,
        ...(client ? { client: client.slice(0, 100) } : {}),
      })) as typeof a;
    } catch (e) {
      console.error(
        JSON.stringify({ msg: "progress.token-check-failed", error: String(e).slice(0, 200) }),
      );
      return fail(503, "the token could not be checked");
    }
    if (!a || typeof a !== "object") return fail(503, "the token could not be checked");
    if (a.ok !== true) {
      const why = typeof a.error === "string" ? a.error : "refused";
      if (why === "scope") return fail(403, "scope");
      return fail(401, why === "expired" ? "expired" : "unknown");
    }
    // The state tree is the site owner's: another account's token, even with
    // the permission, writes nothing (the permission is only offered to owners).
    if (a.owner !== true) return fail(403, "scope");
    if (typeof a.lane !== "string" || !a.lane.trim()) return fail(503, "the token has no name");
    return { root: true, agent: a.lane.trim() };
  }

  private async body(req: Request): Promise<unknown> {
    const raw = await req.text();
    const max = new URL(req.url).pathname.endsWith("/batch") ? MAX_BATCH_BODY : MAX_BODY;
    if (raw.length > max) return fail(413, "body too large");
    try {
      return JSON.parse(raw);
    } catch {
      return fail(400, "body must be JSON");
    }
  }

  private async all() {
    return new Map(
      [...(await this.ctx.storage.list<ProgressEntry>({ prefix: PREFIX })).values()].map((e) => [
        e.id,
        e,
      ]),
    );
  }

  /** The tree (newest first) and the log (oldest first). */
  private async state() {
    const t = this.now();
    const entries = [...(await this.all()).values()]
      .sort((a, b) => b.at - a.at)
      .map((e) => withAgo(e, t));
    const log = [...(await this.ctx.storage.list<ProgressEvent>({ prefix: LOG })).values()];
    return { entries, log };
  }

  async sendSnapshot(to: Socket[] = this.ctx.getWebSockets()) {
    await this.send(to, { type: "snapshot", ...(await this.state()) });
  }

  /** To each reader; a box reader only while its box may still read (boxMay). */
  private async send(to: Socket[], msg: ProgressMessage) {
    const data = JSON.stringify(msg);
    for (const ws of to) {
      const box = boxOf(ws);
      if (box && !(await this.boxMay(ws, box))) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  /** Counts one write; false = over the limit. */
  private allow(name: string) {
    const t = this.now();
    const hit = (key: string, max: number) => {
      const w = this.windows.get(key);
      if (!w || t - w.start >= RATE.windowMs) {
        this.windows.set(key, { start: t, count: 1 });
        return true;
      }
      if (w.count >= max) return false;
      w.count++;
      return true;
    };
    return hit("*", RATE.total) && hit(`n:${name}`, RATE.perName);
  }

  private tooMany() {
    const res = fail(429, "too many updates; slow down");
    res.headers.set("retry-after", String(RATE.windowMs / 1000));
    return res;
  }

  /**
   * Is `id` inside the subtree of `node`? Walks parents: a path's directory,
   * otherwise the stored `parent` (`override` stands in for one node's).
   */
  private covers(
    all: Map<string, ProgressEntry>,
    node: string,
    id: string,
    override?: { id: string; parent?: string },
  ) {
    let x: string | undefined = id;
    for (let i = 0; x !== undefined && i < 64; i++) {
      if (x === node) return true;
      x = isPathId(x) ? pathParent(x) : x === override?.id ? override.parent : all.get(x)?.parent;
    }
    return false;
  }

  /** Would `parent` (through its own ancestors) lead back to `id`? */
  private loops(all: Map<string, ProgressEntry>, id: string, parent: string | undefined) {
    return parent !== undefined && this.covers(all, id, parent);
  }

  /** May this token write this report? A message for the 403, or null. */
  private refuse(
    all: Map<string, ProgressEntry>,
    auth: ProgressAuth,
    r: ProgressReport,
    prev: ProgressEntry | undefined,
  ): string | null {
    if (auth.root && auth.agent === undefined) return null;
    if (r.endedAt !== undefined) return "only the root token back-dates a done node (endedAt)";
    if (auth.root) {
      // An API token: the whole tree, as itself only.
      if (r.assignee.name !== auth.agent)
        return `this token is for ${auth.agent}; it cannot write as ${r.assignee.name}`;
      return null;
    }
    if (r.assignee.name !== auth.agent)
      return `this token is for ${auth.agent}; it cannot write as ${r.assignee.name}`;
    const newParent = r.parent ?? prev?.parent;
    // A to-do for the owner: anyone may ask, about a node in their own scope.
    if (isOwnerTodo(r.id) && !this.covers(all, auth.node, r.id)) {
      if (prev && prev.creator !== auth.agent) return "this to-do was written by someone else";
      const ref = r.ref ?? prev?.ref;
      if (!ref || !this.covers(all, auth.node, ref))
        return `a to-do for the owner needs a ref inside your scope (${auth.node})`;
      return null;
    }
    if (prev) {
      if (!this.covers(all, auth.node, r.id)) return `${r.id} is outside your scope (${auth.node})`;
      if (newParent !== prev.parent) {
        if (r.id === auth.node) return "you cannot move the root of your own scope";
        if (!newParent || !this.covers(all, auth.node, newParent))
          return `cannot move ${r.id} outside your scope (${auth.node})`;
      }
      // Status, pct and eta: the creator's, or an ancestor scope's.
      const mine =
        prev.creator === auth.agent || prev.creator === PROGRESS_AUTO || auth.node !== r.id;
      if (
        !mine &&
        (r.status !== prev.status ||
          (r.pct !== undefined && r.pct !== prev.pct) ||
          (r.eta !== undefined && r.eta !== prev.eta) ||
          r.etaIn !== undefined ||
          r.confirm ||
          (r.etaAt !== undefined && r.etaAt !== prev.etaAt))
      )
        return `only ${prev.creator} (or a scope above) sets the status, pct and eta of ${r.id}`;
      return null;
    }
    if (r.id === auth.node) return null;
    if (!newParent) return `a new node in your scope needs a parent inside it (${auth.node})`;
    if (!this.covers(all, auth.node, r.id, { id: r.id, parent: newParent }))
      return `${r.id} is outside your scope (${auth.node})`;
    return null;
  }

  /**
   * POST /batch {changeId?, reports: [...]}: one action across several nodes.
   * Every report is checked first (400 naming the first bad one, nothing
   * written); then each is written in order with ONE time and ONE change id,
   * so their ETA ticks line up. Each answer is in `results`, in order.
   */
  private async batch(auth: ProgressAuth, body: unknown): Promise<Response> {
    const b = (body ?? {}) as { changeId?: unknown; reports?: unknown };
    if (!Array.isArray(b.reports) || !b.reports.length || b.reports.length > BATCH_MAX)
      return fail(400, `reports must be a list of 1–${BATCH_MAX} reports`);
    const reports: ProgressReport[] = [];
    for (const [i, raw] of b.reports.entries()) {
      const r = parseProgressReport(
        asAgent(
          auth,
          b.changeId === undefined ? raw : { ...(raw as object), changeId: b.changeId },
        ),
      );
      if (r instanceof Error) return fail(400, `reports[${i}]: ${r.message}`);
      reports.push(r);
    }
    const changeId = reports[0]!.changeId ?? newChangeId(this.now());
    const t = this.now();
    const results: unknown[] = [];
    let ok = true;
    for (const r of reports) {
      const res = await this.write(auth, { ...r, changeId }, { t, shared: true });
      const answer = (await res.json()) as Record<string, unknown>;
      results.push(res.ok ? answer : { ...answer, status: res.status });
      if (!res.ok) ok = false;
    }
    return json({ ok, changeId, at: t, results }, ok ? 200 : 207);
  }

  /** A change id seen within CHANGE_ID_WINDOW_MS keeps its first time; else this one is stored. */
  private async changeTime(id: string, t: number): Promise<number> {
    const key = `${CHANGE}${id}`;
    const seen = await this.ctx.storage.get<number>(key);
    if (seen !== undefined && t - seen < CHANGE_ID_WINDOW_MS) return seen;
    await this.ctx.storage.put(key, t);
    const old = await this.ctx.storage.list<number>({ prefix: CHANGE });
    for (const [k, at] of old) if (t - at >= CHANGE_ID_WINDOW_MS) await this.ctx.storage.delete(k);
    return t;
  }

  private async write(
    auth: ProgressAuth,
    r: ProgressReport,
    /** A batch: its one time, and its change id already settled. */
    opts: { t?: number; shared?: boolean } = {},
  ): Promise<Response> {
    const all = await this.all();
    const prev = all.get(r.id);
    const refused = this.refuse(all, auth, r, prev);
    if (refused) return fail(403, refused);
    const parent = r.parent ?? prev?.parent;
    if (this.loops(all, r.id, parent)) return fail(400, `${parent} is inside ${r.id}: a loop`);
    if (parent && !isPathId(parent) && !all.has(parent))
      return fail(400, `unknown parent ${parent}`);
    if (r.rev !== undefined && prev && r.rev <= prev.rev)
      return fail(409, `stale rev ${r.rev}; ${r.id} is at ${prev.rev}`, { rev: prev.rev });
    // A new or renamed name is at most 20 columns; a node keeps the name it has.
    const title = checkTaskTitle(r.task, prev?.task);
    if (title instanceof Error) return fail(400, title.message);
    const t = opts.t ?? this.now();
    if (
      r.etaAt !== undefined &&
      (r.etaAt < t - ETA_GIVE_UP_MS || r.etaAt > t + PROGRESS_ETA_MAX_MS)
    )
      return fail(400, "etaAt must be within the next 30 days");
    // A confirm keeps a time that is still ahead: a passed one is an overrun (below).
    // Waiting on the owner, blocked on someone or paused (lib/eta-nudge.ts): its
    // time passing is not late work.
    const waiting = !!prev && (holdsEta(prev) || holdsEta(mergeProgress(prev, r, t)));
    if (r.confirm) {
      if (prev?.etaAt === undefined || prev.status === "done")
        return fail(400, `${r.id} has no open estimate to confirm: give one with --eta`);
      if (prev.etaAt <= t && !waiting)
        return fail(
          400,
          `${r.id} ran past its ETA: a confirm cannot keep it — --eta 20m --late "why" (the owner is told both)`,
        );
    }
    // ETA overrun (docs/state-tree.md): past its estimate, a new one comes with the reason.
    const newEstimate = r.eta !== undefined || r.etaIn !== undefined || r.etaAt !== undefined;
    if (
      prev &&
      prev.status !== "done" &&
      r.status !== "done" &&
      prev.etaAt !== undefined &&
      prev.etaAt <= t &&
      newEstimate &&
      !r.late &&
      !waiting
    )
      return fail(
        400,
        `${r.id} ran past its ETA: give the reason with the new estimate — --eta 20m --late "why" (the owner is told both)`,
      );
    if (!this.allow(r.assignee.name)) return this.tooMany();

    // A path's missing ancestors become groups, outermost first.
    const missing: ProgressEntry[] = [];
    for (let p = parent; p !== undefined && isPathId(p) && !all.has(p); p = pathParent(p))
      missing.unshift(autoNode(p, r.assignee.name, t));
    const changeId = r.changeId ?? newChangeId(t);
    const changeAt = r.changeId && !opts.shared ? await this.changeTime(r.changeId, t) : t;
    const entry = mergeProgress(prev, r, t, { id: changeId, at: changeAt });
    ownerWaitTransition(prev, entry, t);
    holdTransition(prev, entry, t);
    // Receipts: any report on a node whose "ETA reached" line went out acks it.
    if (prev?.etaAt !== undefined && prev.etaSent === prev.etaAt && entry.etaAt === prev.etaAt)
      entry.etaAcked = prev.etaAt;
    const rules = await this.rules();
    const extra = this.verifyChild(all, prev, entry, rules, t, changeId);
    const events = [
      ...missing.map((e) => progressEvent(e)),
      progressEvent(entry, r.note),
      ...extra.map((e) => progressEvent(e)),
    ];
    const evicted = await this.store([...missing, entry, ...extra], all, rules);
    for (const ev of events) await this.append(lean(ev));
    await this.recordDone(prev, entry, r.endedAt !== undefined);
    for (const e of extra) await this.recordDone(all.get(e.id), e);
    if (evicted) await this.sendSnapshot();
    else for (const ev of events) await this.send(this.ctx.getWebSockets(), withAgo(ev, t));
    // The lane explained an overrun: the owner hears the reason and the new time.
    const told =
      r.late && entry.etaAt !== undefined
        ? (await this.tell({
            id: entry.id,
            title: entry.task,
            etaAt: entry.etaAt,
            assignee: entry.assignee.name,
            kind: "late",
            reason: r.late,
          })) === "ok"
        : undefined;
    return json({
      ok: true,
      entry: withAgo(entry, t),
      changeId,
      readers: this.ctx.getWebSockets().length,
      ...(told === undefined ? {} : { told }),
    });
  }

  /** The receipt, backoff and verify rules: live config values (30 s cache), else the defaults. */
  private rulesAt = 0;
  private rulesNow: NudgeRules = NUDGE_DEFAULTS;
  private async rules(): Promise<NudgeRules> {
    const t = this.now();
    if (this.rulesAt && t - this.rulesAt < RULES_CACHE_MS) return this.rulesNow;
    const rpc = this.sessions;
    const values: Record<string, unknown> = {};
    if (rpc?.config)
      for (const k of ETA_NUDGE_KEYS)
        try {
          values[k] = await rpc.config(k);
        } catch {}
    this.rulesNow = nudgeRules(values);
    this.rulesAt = t;
    return this.rulesNow;
  }

  /**
   * When this node next needs the alarm, and for what: its ETA ping, the
   * owner's reminder, a blocked nudge, the coordinating lane, the owner's
   * "未说明原因" or its repeat, or (done) its pruning.
   */
  private nextAction(
    e: ProgressEntry,
    r: NudgeRules,
  ): {
    at: number;
    kind: "eta" | "remind" | "nudge" | "main" | "silent" | "repeat" | "prune";
  } | null {
    if (e.status === "done") return { at: e.at + PROGRESS_DONE_TTL_MS, kind: "prune" };
    const all: {
      at: number | undefined;
      kind: "eta" | "remind" | "nudge" | "main" | "silent" | "repeat";
    }[] = [
      { at: etaDue(e) ? e.etaAt : undefined, kind: "eta" },
      { at: remindDue(e) ? e.remindAt : undefined, kind: "remind" },
      { at: nudgeDue(e) ? e.nudgeAt : undefined, kind: "nudge" },
      { at: mainAt(e, r), kind: "main" },
      { at: silentAt(e, r), kind: "silent" },
      { at: repeatAt(e), kind: "repeat" },
    ];
    let best: { at: number; kind: (typeof all)[number]["kind"] } | null = null;
    for (const x of all)
      if (x.at !== undefined && (!best || x.at < best.at)) best = { at: x.at, kind: x.kind };
    return best;
  }

  /**
   * Done --unverified (docs/state-tree.md, "Done kinds"): a "verify: <name>"
   * child for the same lane, with a short estimate (chat.verifyEtaMin). Its
   * going done --verified marks the parent verified. The nodes to store.
   */
  private verifyChild(
    all: Map<string, ProgressEntry>,
    prev: ProgressEntry | undefined,
    entry: ProgressEntry,
    rules: NudgeRules,
    t: number,
    changeId: string,
  ): ProgressEntry[] {
    if (entry.status !== "done") return [];
    if (entry.doneKind === "verified" && entry.parent && verifyIdOf(entry.parent) === entry.id) {
      const parent = all.get(entry.parent);
      if (parent?.status !== "done" || parent.doneKind !== "unverified") return [];
      return [
        {
          ...parent,
          doneKind: "verified",
          evidence: `verify: ${entry.evidence ?? entry.id}`.slice(0, PROGRESS_LIMITS.verified),
          by: entry.by,
          rev: parent.rev + 1,
          at: t,
        },
      ];
    }
    if (entry.doneKind !== "unverified") return [];
    if (prev?.status === "done" && prev.doneKind === "unverified") return [];
    const id = verifyIdOf(entry.id);
    if (!id) return [];
    const was = all.get(id);
    if (was && was.status !== "done") return [];
    const name = titleName(entry.task) || entry.task;
    const report: ProgressReport = {
      id,
      parent: entry.id,
      assignee: entry.assignee,
      task: `verify: ${name}`.slice(0, PROGRESS_LIMITS.task),
      status: "doing",
      etaIn: rules.verifyMs,
      eta: `${Math.round(rules.verifyMs / MIN_MS)}m`,
      note: `done but not verified: confirm ${entry.id} works (deployed, tested), then --done --verified "<evidence>"`,
    };
    return [mergeProgress(was, report, t, { id: changeId, at: t })];
  }

  /**
   * POST /ack {code}: the lane got the "ETA reached" line with this receipt
   * code. Its node (in the token's scope) is acked for that estimate: the
   * coordinating lane is not told. The owner still hears "未说明原因" unless a
   * reason and a new ETA come (docs/state-tree.md, "Receipts").
   */
  private async ack(auth: ProgressAuth, body: unknown): Promise<Response> {
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !RECEIPT_RE.test(code)) return fail(400, "expected {code}");
    const all = await this.all();
    const e = [...all.values()].find(
      (x) => x.etaCode === code && x.etaAt !== undefined && x.etaSent === x.etaAt,
    );
    if (!e) return fail(404, `no ETA line with receipt ${code} is open`);
    if (!auth.root && !this.covers(all, auth.node, e.id))
      return fail(403, `${e.id} is outside your scope (${auth.node})`);
    if (!this.allow(who(auth))) return this.tooMany();
    if (e.status !== "done" && e.etaAcked !== e.etaAt)
      await this.ctx.storage.put(progressKey(e), { ...e, etaAcked: e.etaAt });
    return json({ ok: true, id: e.id, task: e.task, etaAt: e.etaAt });
  }

  /**
   * POST /internal/eta-heard (the chat hub, when a listener connects): the
   * lanes' lines held for want of one go out now: queued "ETA reached" lines
   * (their receipt clock starts when heard) and queued blocked nudges.
   */
  private async heard(): Promise<Response> {
    const t = this.now();
    let sent = 0;
    for (const e of (await this.all()).values()) {
      if (e.status === "done") continue;
      if (e.etaAt !== undefined && e.etaQueued === e.etaAt && e.etaSent !== e.etaAt) {
        await this.fireEta(e.id, t, true);
        sent++;
      } else if (e.nudgeQueued !== undefined && nudgeDue({ ...e, nudgeAt: t })) {
        const { nudgeQueued: _q, ...rest } = e;
        await this.ctx.storage.put(progressKey(e), { ...rest, nudgeAt: t });
        await this.fireNudge(e.id, t);
        sent++;
      }
    }
    return json({ ok: true, sent });
  }

  /** Put nodes, making room past PROGRESS_MAX_ENTRIES; true if any were dropped. */
  private async store(
    entries: ProgressEntry[],
    all: Map<string, ProgressEntry>,
    rules: NudgeRules = this.rulesNow,
  ) {
    const fresh = entries.filter((e) => !all.has(e.id)).length;
    const over = all.size + fresh - PROGRESS_MAX_ENTRIES;
    let dropped = false;
    if (over > 0) {
      const keep = new Set(entries.map((e) => e.id));
      const oldest = [...all.values()].filter((e) => !keep.has(e.id)).sort((a, b) => a.at - b.at);
      const order = [
        ...oldest.filter((e) => e.status === "done"),
        ...oldest.filter((e) => e.status !== "done"),
      ];
      for (const e of order.slice(0, over)) {
        await this.ctx.storage.delete(progressKey(e));
        dropped = true;
      }
    }
    for (const e of entries) {
      await this.ctx.storage.put(progressKey(e), e);
      const next = this.nextAction(e, rules);
      if (next) await this.schedule(Math.max(next.at, this.now()));
    }
    return dropped;
  }

  /** Append one event, dropping the oldest past PROGRESS_LOG_MAX. */
  private async append(ev: ProgressEvent) {
    await this.ctx.storage.put(logKey(ev.at, this.seq++ % 1_000_000), ev);
    const keys = [...(await this.ctx.storage.list({ prefix: LOG })).keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - PROGRESS_LOG_MAX)))
      await this.ctx.storage.delete(k);
  }

  /**
   * A done node: its history record (every write, so later PRs and titles
   * reach it). A task that just went done: one record in the stats log too,
   * dropping old ones; not one back-dated (`backdated`: its time is not real).
   */
  private async recordDone(prev: ProgressEntry | undefined, e: ProgressEntry, backdated = false) {
    if (e.status !== "done" || e.kind === "group" || e.kind === "person") return;
    await this.ctx.storage.put(historyKey(e.id), progressHistory(e));
    if (prev?.status === "done" || backdated) return;
    await this.ctx.storage.put(logKey(e.at, this.seq++ % 1_000_000, DONE), progressDone(e));
    await this.ctx.storage.put(historyKey(e.id), progressHistory(e));
    const cut = this.now() - PROGRESS_STATS_TTL_MS;
    const all = [...(await this.ctx.storage.list<ProgressDone>({ prefix: DONE }))];
    for (const [i, [k, d]] of all.entries())
      if (i < all.length - PROGRESS_STATS_MAX || d.at < cut) await this.ctx.storage.delete(k);
  }

  /** The stats log, oldest first, without records past their 30 days. */
  private async doneLog(): Promise<ProgressDone[]> {
    const cut = this.now() - PROGRESS_STATS_TTL_MS;
    return [...(await this.ctx.storage.list<ProgressDone>({ prefix: DONE })).values()].filter(
      (d) => d.at >= cut,
    );
  }

  /**
   * The done history, every record. The first read copies in what the stats
   * log and the live tree know of tasks done before the history existed.
   */
  private async history(): Promise<ProgressHistory[]> {
    if ((await this.ctx.storage.get<number>(HISTORY_MIGRATED)) === undefined) {
      const have = new Set(
        [...(await this.ctx.storage.list({ prefix: HISTORY })).keys()].map((k) =>
          k.slice(HISTORY.length),
        ),
      );
      const add = async (h: ProgressHistory) => {
        if (have.has(h.id)) return;
        have.add(h.id);
        await this.ctx.storage.put(historyKey(h.id), h);
      };
      for (const e of (await this.all()).values())
        if (e.status === "done" && e.kind !== "group" && e.kind !== "person")
          await add(progressHistory(e));
      const done = [...(await this.ctx.storage.list<ProgressDone>({ prefix: DONE })).values()];
      for (const d of done.reverse()) await add(historyFromDone(d));
      await this.ctx.storage.put(HISTORY_MIGRATED, this.now());
    }
    return [...(await this.ctx.storage.list<ProgressHistory>({ prefix: HISTORY })).values()];
  }

  /** The newest `limit` history records (PROGRESS_HISTORY_SEND_DEFAULT when not a number). */
  private async historyAnswer(limit: number): Promise<ProgressHistoryMessage> {
    const all = await this.history();
    const items = newestHistory(all, limit > 0 ? limit : PROGRESS_HISTORY_SEND_DEFAULT);
    return { type: "history", items, total: all.length };
  }

  /**
   * The owner checks off a node: done, `needs` cleared, the answer noted. An
   * owner to-do also resolves the decision or approval it refs.
   */
  async resolve(id: string, note: string = RESOLVED_NOTE): Promise<Response> {
    const all = await this.all();
    const target = all.get(id);
    if (!target) return fail(404, `no node ${id}`);
    if (!this.allow(OWNER_NAME)) return this.tooMany();
    const done: ProgressEntry[] = [];
    const t = this.now();
    const change = { id: newChangeId(t), at: t };
    const close = (e: ProgressEntry) => {
      const r: ProgressReport = {
        id: e.id,
        assignee: { type: "human", name: OWNER_NAME },
        task: e.task,
        status: "done",
        needs: "",
        note,
      };
      done.push(mergeProgress(e, r, t, change));
    };
    if (target.status !== "done") close(target);
    const ref = isOwnerTodo(id) && target.ref ? all.get(target.ref) : undefined;
    if (ref && ref.status !== "done" && (ref.kind === "decision" || ref.kind === "approval"))
      close(ref);
    for (const e of done) {
      // The node keeps its creator and assignee; only `by` says the owner did it.
      const was = all.get(e.id) as ProgressEntry;
      const kept = { ...e, assignee: was.assignee, creator: was.creator };
      await this.ctx.storage.put(progressKey(kept), kept);
      await this.schedule(kept.at + PROGRESS_DONE_TTL_MS);
      const ev = progressEvent(kept, note);
      await this.append(lean(ev));
      await this.recordDone(was, kept);
      await this.send(this.ctx.getWebSockets(), withAgo(ev, t));
    }
    return json({ ok: true, resolved: done.map((e) => e.id) });
  }

  /** Mint a token for `node` (inside the asking token's scope), signed with the root. */
  private async grant(auth: ProgressAuth, body: unknown): Promise<Response> {
    const b = (body ?? {}) as { node?: unknown; agent?: unknown; ttl?: unknown };
    if (!isProgressId(b.node)) return fail(400, "node must be a node id");
    if (typeof b.agent !== "string" || !b.agent.trim() || b.agent.length > PROGRESS_LIMITS.name)
      return fail(400, `agent must be a name of at most ${PROGRESS_LIMITS.name} characters`);
    const ttl = parseTtl(typeof b.ttl === "string" ? b.ttl : GRANT_DEFAULT);
    if (ttl instanceof Error) return fail(400, ttl.message);
    if (!auth.root && !this.covers(await this.all(), auth.node, b.node))
      return fail(403, `${b.node} is outside your scope (${auth.node})`);
    const t = this.now();
    const exp = Math.min(t + Math.min(ttl, GRANT_MAX_MS), auth.root ? Infinity : auth.exp);
    const via = auth.root ? (auth.agent ? `token:${auth.agent}` : "root") : auth.node;
    const grant = { node: b.node, agent: b.agent.trim(), exp, via };
    return json({ token: await mintProgressToken(this.secret!, grant), ...grant });
  }

  /** Make sure the alarm goes off by `at` (one already due is the one running now). */
  private async schedule(at: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur <= this.now()) await this.ctx.storage.setAlarm(at);
  }

  /** The Durable Object alarm: prune done nodes past their TTL and empty auto groups, then wait for the next. */
  async alarm() {
    const t = this.now();
    const all = await this.all();
    const rules = await this.rules();
    let pruned = 0;
    let next = Infinity;
    for (const e of all.values()) {
      if (
        e.status !== "done" &&
        ownerWaits(e) &&
        !etaDue(e) &&
        e.etaAt !== undefined &&
        e.etaSent === e.etaAt &&
        e.remindFor !== e.etaAt
      ) {
        // Pinged before reminders existed: its spaced reminders start from now (no line now).
        const days = await this.remindDays();
        const at = t + remindDelayMs(days, 1);
        await this.ctx.storage.put(progressKey(e), {
          ...e,
          etaSilent: e.etaAt,
          remindFor: e.etaAt,
          remindN: 1,
          remindAt: at,
        });
        next = Math.min(next, at);
        continue;
      }
      const act = this.nextAction(e, rules);
      if (!act) continue;
      if (act.kind === "prune") {
        if (act.at <= t) {
          all.delete(e.id);
          await this.ctx.storage.delete(progressKey(e));
          pruned++;
        } else next = Math.min(next, act.at);
        continue;
      }
      if (act.at > t) {
        next = Math.min(next, act.at);
        continue;
      }
      // Due now: do it, then whatever it leads to that is due too (a few at most).
      for (let a = act, i = 0; i < 4; i++) {
        const ok =
          a.kind === "eta"
            ? await this.fireEta(e.id, t)
            : a.kind === "remind"
              ? await this.fireRemind(e.id, t)
              : a.kind === "nudge"
                ? await this.fireNudge(e.id, t)
                : a.kind === "main"
                  ? await this.fireMain(e.id, t)
                  : await this.fireSilent(e.id, t);
        if (!ok) {
          next = Math.min(next, t + ETA_RETRY_MS);
          break;
        }
        const after = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
        const then = after && this.nextAction(after, rules);
        if (!then || then.kind === "prune") break;
        if (then.at > t || (then.kind === a.kind && then.at === a.at) || i === 3) {
          next = Math.min(next, Math.max(then.at, t + 1));
          break;
        }
        a = then;
      }
    }
    for (let again = pruned > 0; again; ) {
      again = false;
      const parents = new Set([...all.values()].map((e) => e.parent));
      for (const e of all.values())
        if (e.creator === PROGRESS_AUTO && e.kind === "group" && !parents.has(e.id)) {
          all.delete(e.id);
          await this.ctx.storage.delete(progressKey(e));
          again = true;
        }
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
    if (pruned) await this.sendSnapshot();
  }

  /**
   * An estimate ran out: tell the agent, once per `etaAt`. Called by the
   * alarm and by an owner page whose timer went off ({type:"eta", id}); both
   * land here, so two devices (or a page and the alarm) never ping twice.
   * The node is marked sent before the chat hub is asked — storage calls hold
   * the Durable Object's input gate, the fetch does not — and unmarked if it
   * could not take the line (tried again ETA_RETRY_MS later, up to
   * ETA_GIVE_UP_MS late). No listener: queued (`etaQueued`), sent when one
   * connects (`queued`: that call). Not due, done, or already sent: nothing
   * sent. Returns false only when it should be tried again.
   */
  async fireEta(id: string, t: number = this.now(), queued = false): Promise<boolean> {
    // Synchronous claim first: whatever the storage does between awaits, one caller per node.
    if (this.firing.has(id)) return true;
    this.firing.add(id);
    try {
      return await this.fireEtaOnce(id, t, queued);
    } finally {
      this.firing.delete(id);
    }
  }

  private async fireEtaOnce(id: string, t: number, queued: boolean): Promise<boolean> {
    const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
    if (!e || e.status === "done" || !etaDue(e, queued) || e.etaAt! > t + ETA_SKEW_MS) return true;
    const etaAt = e.etaAt!;
    if (ownerWaits(e)) return this.remindOwner(e, t, { etaSent: etaAt, etaSilent: etaAt });
    // Blocked on someone (nudged instead) or paused: its time passing is not late work.
    if (holdsEta(e)) {
      await this.ctx.storage.put(progressKey(e), { ...e, etaSent: etaAt, etaSilent: etaAt });
      return true;
    }
    const { etaQueued: _q, ...rest } = e;
    // Very late (the hub was away): marked sent and silent, never said, no receipt chain.
    if (e.etaQueued !== etaAt && t - etaAt > ETA_GIVE_UP_MS) {
      await this.ctx.storage.put(progressKey(e), { ...rest, etaSent: etaAt, etaSilent: etaAt });
      return true;
    }
    const code = newReceiptCode();
    const sent: ProgressEntry = { ...rest, etaSent: etaAt, etaCode: code };
    await this.ctx.storage.put(progressKey(e), sent);
    if (!this.debug) return true;
    const rules = await this.rules();
    const ping: EtaPing = {
      id: e.id,
      title: e.task,
      etaAt,
      assignee: e.assignee.name,
      code,
      ackMin: Math.round(rules.ackMs / MIN_MS),
      ownerMin: Math.round(rules.ownerMs / MIN_MS),
    };
    const said = await this.tell(ping);
    const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
    const still = now && now.etaSent === etaAt && now.etaCode === code ? now : undefined;
    if (said === "ok") {
      // Heard: the receipt clock starts now.
      const heard: ProgressEntry = { ...(still ?? sent), etaHeardAt: t };
      if (still) await this.ctx.storage.put(progressKey(e), heard);
      // The owner's pages: this one is sent (their timers stop for it).
      await this.send(this.ctx.getWebSockets(), progressEvent(heard));
      const nextAt = this.nextAction(heard, rules)?.at;
      if (nextAt !== undefined) await this.schedule(nextAt);
      return true;
    }
    if (still) {
      const { etaSent: _sent, etaCode: _code, ...back } = still;
      // No listener: held until one connects (ETA_HEARD_PATH); the clock has not started.
      await this.ctx.storage.put(
        progressKey(e),
        said === "queued" ? { ...back, etaQueued: etaAt } : back,
      );
    }
    return said === "queued";
  }

  /**
   * Receipts: the "ETA reached" line was heard ackMs ago and not acked. The
   * coordinating lane (chat.etaCoordinator, "main") is told, once per etaAt;
   * the owner hears "未说明原因" ownerMs later unless a reason and a new ETA
   * come. With no listener for it, it counts as told (nobody to tell).
   */
  async fireMain(id: string, t: number = this.now()): Promise<boolean> {
    const rules = await this.rules();
    const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
    const due = e && mainAt(e, rules);
    if (!e || due === undefined || due > t + ETA_SKEW_MS) return true;
    const etaAt = e.etaAt!;
    await this.ctx.storage.put(progressKey(e), { ...e, etaMain: etaAt });
    if (!this.debug) return true;
    const said = await this.tell({
      id: e.id,
      title: e.task,
      etaAt,
      assignee: e.assignee.name,
      kind: "main",
      lane: rules.coordinator,
      code: e.etaCode,
      ownerMin: Math.round(rules.ownerMs / MIN_MS),
    });
    if (said !== "fail") return true;
    const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
    if (now && now.etaMain === etaAt) {
      const { etaMain: _m, ...back } = now;
      await this.ctx.storage.put(progressKey(e), back);
    }
    return false;
  }

  /**
   * Blocked on someone (`who`; docs/state-tree.md, "Blocked and paused"): the
   * next nudge to that one — the owner in Li (read aloud), a lane by a quiet
   * line addressed to it — then the next at the backoff spacing
   * (chat.nudgeBackoffMin). A lane with no listener: held until one connects.
   */
  async fireNudge(id: string, t: number = this.now()): Promise<boolean> {
    if (this.firing.has(`n:${id}`)) return true;
    this.firing.add(`n:${id}`);
    try {
      const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
      if (!e || !nudgeDue(e) || e.nudgeAt! > t + ETA_SKEW_MS) return true;
      const rules = await this.rules();
      const n = (e.nudgeN ?? 0) + 1;
      const marked: ProgressEntry = {
        ...e,
        nudgeN: n,
        nudgeAt: t + backoffDelayMs(rules.backoffMs, n),
      };
      await this.ctx.storage.put(progressKey(e), marked);
      if (!this.debug) return true;
      const said = await this.tell({
        id: e.id,
        title: e.task,
        etaAt: e.etaAt ?? t,
        assignee: e.assignee.name,
        kind: "blocked",
        lane: blockedOn(e)!,
        n,
        ...(e.needs?.trim() ? { reason: e.needs.trim() } : {}),
      });
      if (said === "ok") {
        await this.schedule(marked.nudgeAt!);
        return true;
      }
      const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
      if (now && now.rev === marked.rev && now.nudgeAt === marked.nudgeAt) {
        if (said === "queued") {
          const { nudgeAt: _at, ...rest } = e;
          await this.ctx.storage.put(progressKey(e), { ...rest, nudgeQueued: n });
        } else await this.ctx.storage.put(progressKey(e), e);
      }
      return said === "queued";
    } finally {
      this.firing.delete(`n:${id}`);
    }
  }

  /**
   * Waiting on the owner (lib/owner-wait.ts; docs/state-tree.md, "Waiting on
   * the owner"): the next spaced reminder is due. Once per remindAt, as
   * fireEta (claimed, marked first, put back if the chat hub could not take
   * it). Not due, done, or no longer waiting: true, nothing sent.
   */
  async fireRemind(id: string, t: number = this.now()): Promise<boolean> {
    if (this.firing.has(id)) return true;
    this.firing.add(id);
    try {
      const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
      if (!e || !remindDue(e) || e.remindAt! > t + ETA_SKEW_MS) return true;
      return await this.remindOwner(e, t, {});
    } finally {
      this.firing.delete(id);
    }
  }

  /**
   * One reminder to the owner that a node waits on him, with its reason
   * ("<name>：在等你——<needs>", read aloud; never the lane's "ETA reached"
   * line, never "未说明原因"), and the next one scheduled further out. `mark`:
   * what else the first one marks (its etaAt pinged and never "silent").
   */
  private async remindOwner(
    e: ProgressEntry,
    t: number,
    mark: Partial<ProgressEntry>,
  ): Promise<boolean> {
    const etaAt = e.etaAt!;
    const fresh = e.remindFor !== etaAt;
    const sent = fresh ? 1 : (e.remindN ?? 0) + 1;
    const at = t + remindDelayMs(await this.remindDays(), sent);
    const marked: ProgressEntry = { ...e, ...mark, remindFor: etaAt, remindN: sent, remindAt: at };
    await this.ctx.storage.put(progressKey(e), marked);
    if (!this.debug) return true;
    const ok =
      (await this.tell({
        id: e.id,
        title: e.task,
        etaAt,
        assignee: e.assignee.name,
        kind: "waiting",
        ...(e.needs?.trim() ? { reason: e.needs.trim() } : {}),
      })) !== "fail";
    if (ok) {
      if (fresh) await this.send(this.ctx.getWebSockets(), progressEvent(marked));
      await this.schedule(at);
      return true;
    }
    // Not taken: put it back unless the node moved meanwhile.
    const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
    if (now && now.rev === marked.rev && now.remindAt === at)
      await this.ctx.storage.put(progressKey(e), e);
    return false;
  }

  /** The reminder spacing in days: the live config value, or its default when it cannot be read. */
  private async remindDays(): Promise<number[]> {
    const rpc = this.sessions;
    try {
      return parseRemindDays(rpc?.config ? await rpc.config(OWNER_WAIT_REMIND_KEY) : undefined);
    } catch {
      return parseRemindDays(undefined);
    }
  }

  /**
   * One line through the chat hub (debug.ts ETA_PATH): "ok" if it took it,
   * "queued" if a lanes' line found no listener (not posted), "fail" otherwise.
   */
  private async tell(ping: EtaPing): Promise<"ok" | "queued" | "fail"> {
    if (!this.debug) return "fail";
    let said: "ok" | "queued" | "fail" = "fail";
    try {
      const res = await this.debug.get(this.debug.idFromName("debug")).fetch(
        new Request(`https://lianki-push${ETA_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ping),
        }),
      );
      if (res.ok) {
        let body: { queued?: unknown } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {}
        said = body?.queued === true ? "queued" : "ok";
      }
    } catch {}
    console.log(
      JSON.stringify({
        msg: "progress.eta",
        kind: ping.kind ?? "due",
        id: ping.id,
        etaAt: ping.etaAt,
        said,
      }),
    );
    return said;
  }

  /**
   * ETA overrun, unexplained: the "due" line was heard ackMs + ownerMs ago
   * and neither a reason nor a new estimate came. The owner is told "<name>
   * 超时，未说明原因", once per etaAt (marked first, unmarked if the chat hub
   * could not take it; given up, marked, when very late), then again with
   * backoff (chat.nudgeBackoffMin: 10, 20, 40… minutes, at most every 4 h)
   * until a reason and a new ETA come or it is done. False: try again later.
   */
  async fireSilent(id: string, t: number = this.now()): Promise<boolean> {
    const rules = await this.rules();
    const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
    if (!e) return true;
    const etaAt = e.etaAt!;
    const first = silentAt(e, rules);
    const repeat = repeatAt(e);
    const due = first ?? repeat;
    if (due === undefined || due > t + ETA_SKEW_MS) return true;
    const n = first !== undefined ? 0 : (e.silentN ?? 0) + 1;
    // A first one far past due (the hub was away, or an old ping): marked, not said, no repeats.
    const stale = first !== undefined && t - first > ETA_GIVE_UP_MS;
    const marked: ProgressEntry = {
      ...e,
      etaSilent: etaAt,
      silentN: n,
      ...(stale ? {} : { silentAt: t + backoffDelayMs(rules.backoffMs, n + 1) }),
    };
    if (stale) delete marked.silentAt;
    await this.ctx.storage.put(progressKey(e), marked);
    if (stale || !this.debug) return true;
    const said = await this.tell({
      id: e.id,
      title: e.task,
      etaAt,
      assignee: e.assignee.name,
      kind: "silent",
      ...(n ? { n } : {}),
    });
    if (said !== "fail") {
      if (marked.silentAt !== undefined) await this.schedule(marked.silentAt);
      return true;
    }
    const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
    if (now && now.etaSilent === etaAt && now.silentN === n && now.silentAt === marked.silentAt)
      await this.ctx.storage.put(progressKey(e), e);
    return false;
  }

  /**
   * The owner's page: {type:"resolve", id, note?} checks off a node;
   * {type:"eta", id} says its timer for that node went off; {type:"history",
   * limit?} asks for the done history, answered to this socket only. Nothing
   * else is heard.
   */
  async webSocketMessage(ws: Socket, raw: string | ArrayBuffer) {
    let m: { type?: unknown; id?: unknown; note?: unknown; limit?: unknown };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    // The owner's box: its ETA pings and history reads only, each while its box may still chat (asked now).
    const box = boxOf(ws);
    if (box) {
      const reads = m?.type === "history" || (m?.type === "eta" && isProgressId(m.id));
      if (!reads || !(await this.boxMay(ws, box, true))) return;
    }
    if (m?.type === "history") {
      const answer = await this.historyAnswer(typeof m.limit === "number" ? m.limit : 0);
      try {
        ws.send(JSON.stringify(answer));
      } catch {}
      return;
    }
    if (m?.type === "eta" && isProgressId(m.id)) {
      if (!(await this.fireEta(m.id))) await this.schedule(this.now() + ETA_RETRY_MS);
      return;
    }
    if (m?.type !== "resolve" || !isProgressId(m.id)) return;
    const note = typeof m.note === "string" && m.note.trim() ? m.note.trim() : RESOLVED_NOTE;
    await this.resolve(m.id, note.slice(0, PROGRESS_LIMITS.note));
  }
  webSocketClose(ws: Socket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
  webSocketError(ws: Socket) {
    this.webSocketClose(ws, 1011);
  }
}
