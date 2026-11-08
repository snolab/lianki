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
 * Writers are rate limited per name and in total, in memory: an evicted hub
 * starts a fresh window, which is fine for a limit meant to stop a runaway loop.
 */
import {
  OWNER_NAME,
  PROGRESS_AUTO,
  PROGRESS_DONE_TTL_MS,
  PROGRESS_ETA_MAX_MS,
  PROGRESS_LIMITS,
  PROGRESS_LOG_MAX,
  PROGRESS_MAX_ENTRIES,
  PROGRESS_STATS_MAX,
  PROGRESS_STATS_TTL_MS,
  type ProgressDone,
  type ProgressEntry,
  type ProgressEvent,
  type ProgressMessage,
  type ProgressReport,
  autoNode,
  isOwnerTodo,
  isPathId,
  isProgressId,
  mergeProgress,
  parseProgressReport,
  parseTtl,
  pathParent,
  progressDone,
  progressEvent,
  progressKey,
} from "../../../lib/progress";
import {
  type ProgressAuth,
  mintProgressToken,
  verifyProgressToken,
} from "../../../lib/progress-token";
import type { Socket, Storage } from "./debug";
import { ETA_PATH, type EtaPing } from "../../../lib/eta-ping";

export type ProgressState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: Storage;
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

/** Set by index.ts after the owner check; never trusted from the client. */
export const PROGRESS_OWNER_HEADER = "x-progress-owner";
/** Writes allowed per window: per name, and for everyone together. */
export const RATE = { windowMs: 60_000, perName: 30, total: 120 } as const;
/** A report is a few hundred bytes; anything much bigger is not one. */
export const MAX_BODY = 4096;
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

type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
};

/** The note a check-off writes. */
export const RESOLVED_NOTE = "resolved by owner";

const PREFIX = "e:";
/** Log keys sort in the order the events happened: time, then a sequence number. */
const LOG = "l:";
const logKey = (at: number, seq: number, prefix = LOG) =>
  `${prefix}${String(at).padStart(15, "0")}:${String(seq).padStart(6, "0")}`;
/** The stats log: one record per task that went done, kept PROGRESS_STATS_TTL_MS. */
const DONE = "d:";

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

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, status);

/** An open node whose estimate has not been pinged yet. */
const etaDue = (e: ProgressEntry) => e.etaAt !== undefined && e.etaSent !== e.etaAt;

export class ProgressHub {
  private windows = new Map<string, { start: number; count: number }>();
  private seq = 0;
  private secret: string | undefined;
  /** The chat hub (debug.ts), where an ETA ping becomes a line in the owner's thread. */
  private debug: Namespace | undefined;
  /** Nodes whose ping is being sent right now (fireEta): a second caller backs off at once. */
  private firing = new Set<string>();

  constructor(
    private ctx: ProgressState,
    env?: { PROGRESS_TOKEN?: string; DEBUG?: Namespace },
    private now: () => number = Date.now,
  ) {
    this.secret = env?.PROGRESS_TOKEN;
    this.debug = env?.DEBUG;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (req.headers.get(PROGRESS_OWNER_HEADER) !== "1")
        return new Response("forbidden", { status: 403 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      await this.sendSnapshot([pair[1]]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const auth = this.secret ? await verifyProgressToken(this.secret, token, this.now()) : null;
    if (!auth) return fail(401, "unauthorized (wrong, forged or expired token)");
    if (req.method === "GET")
      return json(path.endsWith("/stats") ? { done: await this.doneLog() } : await this.state());
    if (req.method !== "POST") return fail(405, "GET or POST");
    const body = await this.body(req);
    if (body instanceof Response) return body;
    if (path.endsWith("/grant")) return this.grant(auth, body);
    if (path.endsWith("/resolve")) {
      if (!auth.root) return fail(403, "only the owner (the root token) resolves");
      const b = body as { id?: unknown; note?: unknown };
      if (!isProgressId(b.id)) return fail(400, "id is required");
      const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : RESOLVED_NOTE;
      return this.resolve(b.id, note.slice(0, PROGRESS_LIMITS.note));
    }
    const report = parseProgressReport(body);
    if (report instanceof Error) return fail(400, report.message);
    return this.write(auth, report);
  }

  private async body(req: Request): Promise<unknown> {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return fail(413, "body too large");
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
    const entries = [...(await this.all()).values()].sort((a, b) => b.at - a.at);
    const log = [...(await this.ctx.storage.list<ProgressEvent>({ prefix: LOG })).values()];
    return { entries, log };
  }

  async sendSnapshot(to: Socket[] = this.ctx.getWebSockets()) {
    this.send(to, { type: "snapshot", ...(await this.state()) });
  }

  private send(to: Socket[], msg: ProgressMessage) {
    const data = JSON.stringify(msg);
    for (const ws of to)
      try {
        ws.send(data);
      } catch {}
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
    if (auth.root) return null;
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

  private async write(auth: ProgressAuth, r: ProgressReport): Promise<Response> {
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
    const t = this.now();
    if (
      r.etaAt !== undefined &&
      (r.etaAt < t - ETA_GIVE_UP_MS || r.etaAt > t + PROGRESS_ETA_MAX_MS)
    )
      return fail(400, "etaAt must be within the next 30 days");
    if (!this.allow(r.assignee.name)) return this.tooMany();

    // A path's missing ancestors become groups, outermost first.
    const missing: ProgressEntry[] = [];
    for (let p = parent; p !== undefined && isPathId(p) && !all.has(p); p = pathParent(p))
      missing.unshift(autoNode(p, r.assignee.name, t));
    const entry = mergeProgress(prev, r, t);
    const events = [...missing.map((e) => progressEvent(e)), progressEvent(entry, r.note)];
    const evicted = await this.store([...missing, entry], all);
    for (const ev of events) await this.append(ev);
    await this.recordDone(prev, entry);
    if (evicted) await this.sendSnapshot();
    else for (const ev of events) this.send(this.ctx.getWebSockets(), ev);
    return json({ ok: true, entry, readers: this.ctx.getWebSockets().length });
  }

  /** Put nodes, making room past PROGRESS_MAX_ENTRIES; true if any were dropped. */
  private async store(entries: ProgressEntry[], all: Map<string, ProgressEntry>) {
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
      if (e.status === "done") await this.schedule(e.at + PROGRESS_DONE_TTL_MS);
      else if (etaDue(e)) await this.schedule(Math.max(e.etaAt!, this.now()));
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

  /** A task that just went done: one record in the stats log, dropping old ones. */
  private async recordDone(prev: ProgressEntry | undefined, e: ProgressEntry) {
    if (e.status !== "done" || prev?.status === "done") return;
    if (e.kind === "group" || e.kind === "person") return;
    await this.ctx.storage.put(logKey(e.at, this.seq++ % 1_000_000, DONE), progressDone(e));
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
   * The owner checks off a node: done, `needs` cleared, the answer noted. An
   * owner to-do also resolves the decision or approval it refs.
   */
  async resolve(id: string, note: string = RESOLVED_NOTE): Promise<Response> {
    const all = await this.all();
    const target = all.get(id);
    if (!target) return fail(404, `no node ${id}`);
    if (!this.allow(OWNER_NAME)) return this.tooMany();
    const done: ProgressEntry[] = [];
    const close = (e: ProgressEntry) => {
      const r: ProgressReport = {
        id: e.id,
        assignee: { type: "human", name: OWNER_NAME },
        task: e.task,
        status: "done",
        needs: "",
        note,
      };
      done.push(mergeProgress(e, r, this.now()));
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
      await this.append(ev);
      await this.recordDone(was, kept);
      this.send(this.ctx.getWebSockets(), ev);
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
    const grant = { node: b.node, agent: b.agent.trim(), exp, via: auth.root ? "root" : auth.node };
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
    let pruned = 0;
    let next = Infinity;
    for (const e of all.values()) {
      if (e.status !== "done" && etaDue(e)) {
        // An estimate ran out: ping the agent (fireEta), or wait for it.
        if (e.etaAt! > t) next = Math.min(next, e.etaAt!);
        else if (!(await this.fireEta(e.id, t))) next = Math.min(next, t + ETA_RETRY_MS);
        continue;
      }
      if (e.status !== "done") continue;
      const due = e.at + PROGRESS_DONE_TTL_MS;
      if (due <= t) {
        all.delete(e.id);
        await this.ctx.storage.delete(progressKey(e));
        pruned++;
      } else next = Math.min(next, due);
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
   * ETA_GIVE_UP_MS late). Not due, done, or already sent: false, nothing sent.
   * Returns false only when it should be tried again.
   */
  async fireEta(id: string, t: number = this.now()): Promise<boolean> {
    // Synchronous claim first: whatever the storage does between awaits, one caller per node.
    if (this.firing.has(id)) return true;
    this.firing.add(id);
    try {
      return await this.fireEtaOnce(id, t);
    } finally {
      this.firing.delete(id);
    }
  }

  private async fireEtaOnce(id: string, t: number): Promise<boolean> {
    const e = await this.ctx.storage.get<ProgressEntry>(progressKey({ id }));
    if (!e || e.status === "done" || !etaDue(e) || e.etaAt! > t + ETA_SKEW_MS) return true;
    const etaAt = e.etaAt!;
    const late = t - etaAt > ETA_GIVE_UP_MS;
    const sent = { ...e, etaSent: etaAt };
    await this.ctx.storage.put(progressKey(e), sent);
    if (late || !this.debug) return true;
    const ping: EtaPing = { id: e.id, title: e.task, etaAt, assignee: e.assignee.name };
    let ok = false;
    try {
      const res = await this.debug.get(this.debug.idFromName("debug")).fetch(
        new Request(`https://lianki-push${ETA_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ping),
        }),
      );
      ok = res.ok;
    } catch {}
    console.log(JSON.stringify({ msg: "progress.eta", id: e.id, etaAt, ok }));
    if (ok) {
      // The owner's pages: this one is sent (their timers stop for it).
      this.send(this.ctx.getWebSockets(), progressEvent(sent));
      return true;
    }
    const now = await this.ctx.storage.get<ProgressEntry>(progressKey(e));
    if (now && now.etaSent === etaAt) {
      const { etaSent: _sent, ...back } = now;
      await this.ctx.storage.put(progressKey(e), back);
    }
    return false;
  }

  /**
   * The owner's page: {type:"resolve", id, note?} checks off a node;
   * {type:"eta", id} says its timer for that node went off. Nothing else is heard.
   */
  async webSocketMessage(_ws: Socket, raw: string | ArrayBuffer) {
    let m: { type?: unknown; id?: unknown; note?: unknown };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
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
