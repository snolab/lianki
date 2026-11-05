/**
 * The node tree on D1 (docs/calendar-plan.md, sections 2 and 6;
 * db/migrations/0018_nodes.sql).
 *
 * Everything is a node — a plan, a todo, a note, a study session. Reads are
 * subtree-by-depth; every write is a changeset: a list of generic ops applied
 * in one D1 batch together with its inverse (for undo) and one node_events row
 * per op (for subscribers). The partner applies changesets directly (owner,
 * 2026-10-31); undo is itself a changeset.
 *
 * Concurrency: ops are checked in JS against the rows read just before, and
 * the batch carries the next node_events seq numbers. Two writers racing for
 * the same seq make one batch fail as a whole (primary key), and that writer
 * re-reads and retries — so a changeset never lands half-applied or on a
 * stale read.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { checkFields, normalizeTags } from "@/lib/tree/tags";
import { isValidTimeZone, UTC } from "@/lib/tree/tz";

type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

export const MAX_OPS = 50;
export const MAX_TITLE = 300;
export const MAX_SUMMARY = 200;
export const MAX_SUBTREE = 2000;
export const NODE_STATUSES = ["open", "doing", "blocked", "done", "dropped"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export type TimeFacet = {
  start: string;
  end: string;
  tz: string;
  rrule?: string | null;
  originalStart?: string | null;
};

export type TreeNode = {
  id: string;
  parent: string | null;
  slug: string | null;
  title: string;
  status: NodeStatus | null;
  tags: string[];
  fields: Record<string, unknown>;
  sort: number;
  version: number;
  time: TimeFacet | null;
  createdAt: string;
  updatedAt: string;
  /** Levels below the node a subtree read started from. */
  depth?: number;
};

type Editable = {
  title?: string;
  slug?: string | null;
  status?: NodeStatus | null;
  tags?: string[];
  fields?: Record<string, unknown>;
  sort?: number;
  time?: Partial<TimeFacet> | null;
};

export type NodeOp =
  | ({ op: "create"; id?: string; parent: string | null; title: string } & Omit<Editable, "title">)
  | ({ op: "update"; id: string; ifVersion?: number } & Editable)
  | { op: "move"; id: string; parent: string | null; sort?: number; ifVersion?: number }
  | { op: "delete"; id: string; ifVersion?: number }
  | { op: "restore"; id: string; deletedAt: string };

export type Changeset = {
  id: string;
  summary: string;
  ops: NodeOp[];
  inverse: NodeOp[];
  by: string;
  status: "applied" | "undone";
  createdAt: string;
  undoneAt: string | null;
};

/** A rejected op: the API answers 400 (409 for a stale version) with it. */
export class TreeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

type NodeRow = {
  id: string;
  user_id: string;
  parent_id: string | null;
  slug: string | null;
  title: string;
  status: string | null;
  tags: string;
  fields: string;
  sort: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  t_start?: string | null;
  t_end?: string | null;
  t_tz?: string | null;
  t_rrule?: string | null;
  t_original?: string | null;
  d?: number;
};

const SELECT_NODE = `SELECT n.*, t.start_at AS t_start, t.end_at AS t_end, t.tz AS t_tz,
  t.rrule AS t_rrule, t.original_start AS t_original
  FROM nodes n LEFT JOIN node_times t ON t.node_id = n.id`;

function toNode(r: NodeRow): TreeNode {
  return {
    id: r.id,
    parent: r.parent_id,
    slug: r.slug,
    title: r.title,
    status: (r.status as NodeStatus | null) ?? null,
    tags: JSON.parse(r.tags || "[]"),
    fields: JSON.parse(r.fields || "{}"),
    sort: r.sort,
    version: r.version,
    time: r.t_start
      ? {
          start: r.t_start,
          end: r.t_end as string,
          tz: r.t_tz as string,
          rrule: r.t_rrule ?? null,
          originalStart: r.t_original ?? null,
        }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.d != null && { depth: Number(r.d) }),
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isIso = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s));

function checkTitle(t: unknown): string {
  if (typeof t !== "string" || !t.trim()) throw new TreeError("title is required");
  return t.trim().slice(0, MAX_TITLE);
}
function checkSlug(s: unknown): string | null {
  if (s == null) return null;
  if (typeof s !== "string" || !SLUG.test(s)) throw new TreeError(`bad slug: ${String(s)}`);
  return s;
}
function checkStatus(s: unknown): NodeStatus | null {
  if (s == null) return null;
  if (!NODE_STATUSES.includes(s as NodeStatus)) throw new TreeError(`bad status: ${String(s)}`);
  return s as NodeStatus;
}
/** A full, valid time facet; an unknown or invalid zone becomes UTC. */
function checkTime(t: Partial<TimeFacet>, fallbackTz: string): TimeFacet {
  const start = t.start;
  const end = t.end;
  if (!isIso(start) || !isIso(end)) throw new TreeError("time needs ISO start and end");
  const s = new Date(start).toISOString();
  const e = new Date(end).toISOString();
  if (e <= s) throw new TreeError("time: end must be after start");
  if (
    t.rrule != null &&
    (typeof t.rrule !== "string" || !t.rrule.startsWith("FREQ=") || t.rrule.length > 200)
  )
    throw new TreeError("bad rrule");
  if (t.originalStart != null && !isIso(t.originalStart)) throw new TreeError("bad originalStart");
  return {
    start: s,
    end: e,
    tz: isValidTimeZone(t.tz) ? t.tz : isValidTimeZone(fallbackTz) ? fallbackTz : UTC,
    rrule: t.rrule ?? null,
    originalStart: t.originalStart ? new Date(t.originalStart).toISOString() : null,
  };
}

/** Working copy of one node while a changeset is computed. */
type Draft = {
  node: TreeNode;
  deletedAt: string | null;
  isNew: boolean;
  dirty: boolean;
  timeDirty: boolean;
};

export class NodesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly userId: string,
    /** Zone for time facets that name none: the user's, or UTC when unknown. */
    private readonly tz: string = UTC,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<TreeNode | null> {
    const r = await this.db
      .prepare(`${SELECT_NODE} WHERE n.id = ? AND n.user_id = ? AND n.deleted_at IS NULL`)
      .bind(id, this.userId)
      .first<NodeRow>();
    return r ? toNode(r) : null;
  }

  /**
   * The node and its live descendants down to `depth` levels (-1 = all), in
   * tree order by `sort`. `node` null = the roots (depth counts from them).
   */
  async subtree(node: string | null, depth = 1): Promise<TreeNode[]> {
    const deep = depth < 0 ? -1 : Math.floor(depth);
    const seed =
      node == null
        ? `SELECT id, 0 AS d FROM nodes WHERE user_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL`
        : `SELECT id, 0 AS d FROM nodes WHERE user_id = ?1 AND id = ?4 AND deleted_at IS NULL`;
    const { results } = await this.db
      .prepare(
        `WITH RECURSIVE tr(id, d) AS (
           ${seed}
           UNION ALL
           SELECT c.id, tr.d + 1 FROM nodes c JOIN tr ON c.parent_id = tr.id
           WHERE c.user_id = ?1 AND c.deleted_at IS NULL AND (?2 < 0 OR tr.d < ?2)
         )
         ${SELECT_NODE.replace("FROM nodes n", ", tr.d AS d FROM tr JOIN nodes n ON n.id = tr.id")}
         ORDER BY tr.d, n.sort, n.created_at LIMIT ?3`,
      )
      .bind(this.userId, deep, MAX_SUBTREE, ...(node == null ? [] : [node]))
      .all<NodeRow>();
    return results.map(toNode);
  }

  /** "/plan/japanese" → the node, by slugs from a root. */
  async resolvePath(path: string): Promise<TreeNode | null> {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return null;
    let parent: string | null = null;
    let found: NodeRow | null = null;
    for (const slug of parts) {
      found = await this.db
        .prepare(
          `${SELECT_NODE} WHERE n.user_id = ? AND COALESCE(n.parent_id, '') = ? AND n.slug = ?
           AND n.deleted_at IS NULL`,
        )
        .bind(this.userId, parent ?? "", slug)
        .first<NodeRow>();
      if (!found) return null;
      parent = found.id;
    }
    return found ? toNode(found) : null;
  }

  /** Timed nodes overlapping [from, to), series included (expanded by the client). */
  async timed(from: string, to: string): Promise<TreeNode[]> {
    const { results } = await this.db
      .prepare(
        `${SELECT_NODE} WHERE n.user_id = ? AND n.deleted_at IS NULL AND t.node_id IS NOT NULL
         AND t.start_at < ? AND (t.end_at > ? OR t.rrule IS NOT NULL)
         ORDER BY t.start_at LIMIT ?`,
      )
      .bind(this.userId, to, from, MAX_SUBTREE)
      .all<NodeRow>();
    return results.map(toNode);
  }

  /** The live root tagged `plan`, made (with no changeset: an empty node) when missing. */
  async ensurePlanRoot(locale = "en"): Promise<TreeNode> {
    const find = () =>
      this.db
        .prepare(
          `${SELECT_NODE} WHERE n.user_id = ? AND n.parent_id IS NULL AND n.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM json_each(n.tags) WHERE json_each.value = 'plan')
           ORDER BY n.created_at LIMIT 1`,
        )
        .bind(this.userId)
        .first<NodeRow>();
    const have = await find();
    if (have) return toNode(have);
    const title = locale.startsWith("zh")
      ? "学习计划"
      : locale.startsWith("ja")
        ? "学習計画"
        : "Study plan";
    try {
      await this.write([{ op: "create", parent: null, slug: "plan", title, tags: ["plan"] }], {
        summary: "",
        by: "user",
        log: false,
      });
    } catch {
      // A concurrent request made it (the slug is unique among roots).
    }
    const made = await find();
    if (!made) throw new TreeError("could not create the plan root", 409);
    return toNode(made);
  }

  async changesets(limit = 50): Promise<Changeset[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM changesets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(this.userId, Math.min(200, Math.max(1, limit)))
      .all<Record<string, string>>();
    return results.map((r) => ({
      id: r.id,
      summary: r.summary,
      ops: JSON.parse(r.ops),
      inverse: JSON.parse(r.inverse),
      by: r.by,
      status: r.status as Changeset["status"],
      createdAt: r.created_at,
      undoneAt: r.undone_at ?? null,
    }));
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Apply `ops` directly as one changeset; returns it (with its inverse). */
  async apply(ops: NodeOp[], meta: { summary: string; by: string }): Promise<Changeset> {
    const summary =
      typeof meta.summary === "string" ? meta.summary.trim().slice(0, MAX_SUMMARY) : "";
    if (!summary) throw new TreeError("summary is required");
    return (await this.write(ops, { summary, by: meta.by, log: true })) as Changeset;
  }

  /** Undo an applied changeset: its inverse, applied as a new changeset. */
  async undo(id: string, by: string): Promise<Changeset> {
    const row = await this.db
      .prepare(`SELECT * FROM changesets WHERE id = ? AND user_id = ?`)
      .bind(id, this.userId)
      .first<Record<string, string>>();
    if (!row) throw new TreeError("no such changeset", 404);
    if (row.status !== "applied") throw new TreeError("already undone", 409);
    // Only the first inverse op on a node can know its current version: each one
    // applied bumps it, so later ops on the same node drop their check.
    const seen = new Set<string>();
    const inverse = (JSON.parse(row.inverse) as NodeOp[]).map((op) => {
      const id = op.id ?? "";
      if (seen.has(id) && "ifVersion" in op) {
        const { ifVersion: _drop, ...rest } = op;
        return rest as NodeOp;
      }
      seen.add(id);
      return op;
    });
    const cs = (await this.write(inverse, {
      summary: `Undo: ${row.summary}`.slice(0, MAX_SUMMARY),
      by,
      log: true,
      undoes: id,
    })) as Changeset;
    return cs;
  }

  private async write(
    ops: NodeOp[],
    meta: { summary: string; by: string; log: boolean; undoes?: string },
  ): Promise<Changeset | null> {
    if (!Array.isArray(ops) || !ops.length) throw new TreeError("ops must be a non-empty array");
    if (ops.length > MAX_OPS) throw new TreeError(`at most ${MAX_OPS} ops per changeset`);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.writeOnce(ops, meta);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 2 && /UNIQUE constraint failed: node_events/.test(msg)) continue;
        if (/UNIQUE constraint failed: nodes/.test(msg))
          throw new TreeError("a sibling already has that slug", 409);
        throw e;
      }
    }
  }

  private async writeOnce(
    ops: NodeOp[],
    meta: { summary: string; by: string; log: boolean; undoes?: string },
  ): Promise<Changeset | null> {
    const now = new Date().toISOString();
    const drafts = new Map<string, Draft>();
    const load = async (id: string, includeDeleted = false): Promise<Draft> => {
      const have = drafts.get(id);
      if (have) {
        if (have.deletedAt && !includeDeleted) throw new TreeError(`node ${id} is deleted`, 404);
        return have;
      }
      const r = await this.db
        .prepare(`${SELECT_NODE} WHERE n.id = ? AND n.user_id = ?`)
        .bind(id, this.userId)
        .first<NodeRow>();
      if (!r || (r.deleted_at && !includeDeleted)) throw new TreeError(`no such node: ${id}`, 404);
      const d: Draft = {
        node: toNode(r),
        deletedAt: r.deleted_at,
        isNew: false,
        dirty: false,
        timeDirty: false,
      };
      drafts.set(id, d);
      return d;
    };
    const chain = async (parent: string | null): Promise<string[]> => {
      const out: string[] = [];
      for (let p = parent; p; ) {
        if (out.includes(p) || out.length > 256) throw new TreeError("tree too deep or cyclic");
        out.unshift(p);
        p = (await load(p, true)).node.parent;
      }
      return out;
    };
    const checkVersion = (d: Draft, v: number | undefined) => {
      if (v != null && d.node.version !== v)
        throw new TreeError(
          `node ${d.node.id} changed (version ${d.node.version}, expected ${v})`,
          409,
        );
    };

    const inverse: NodeOp[] = [];
    const events: { node: string; type: string; ancestors: string[]; old?: string[] }[] = [];
    /** Descendant ids of `id`: live ones (stamp null) or those deleted with `stamp`. */
    const descendants = async (id: string, stamp: string | null): Promise<string[]> => {
      const { results } = await this.db
        .prepare(
          `WITH RECURSIVE s(id) AS (
             SELECT id FROM nodes WHERE parent_id = ?1 AND user_id = ?2 AND deleted_at IS ?3
             UNION ALL
             SELECT c.id FROM nodes c JOIN s ON c.parent_id = s.id WHERE c.user_id = ?2 AND c.deleted_at IS ?3
           ) SELECT id FROM s LIMIT ${MAX_SUBTREE}`,
        )
        .bind(id, this.userId, stamp)
        .all<{ id: string }>();
      return results.map((r) => r.id);
    };

    for (const op of ops) {
      switch (op?.op) {
        case "create": {
          const id = op.id ?? crypto.randomUUID();
          if (
            drafts.has(id) ||
            (await this.db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).bind(id).first())
          )
            throw new TreeError(`node ${id} exists`, 409);
          if (op.parent) await load(op.parent);
          const tags = normalizeTags(op.tags ?? []);
          const fields = checkFields(op.fields ?? {}, tags);
          if (!fields) throw new TreeError("fields must be an object under 8 KB");
          const node: TreeNode = {
            id,
            parent: op.parent ?? null,
            slug: checkSlug(op.slug),
            title: checkTitle(op.title),
            status: checkStatus(op.status),
            tags,
            fields,
            sort: typeof op.sort === "number" && Number.isFinite(op.sort) ? op.sort : Date.now(),
            version: 1,
            time: op.time ? checkTime(op.time, this.tz) : null,
            createdAt: now,
            updatedAt: now,
          };
          drafts.set(id, {
            node,
            deletedAt: null,
            isNew: true,
            dirty: true,
            timeDirty: !!node.time,
          });
          inverse.unshift({ op: "delete", id });
          events.push({ node: id, type: "created", ancestors: await chain(node.parent) });
          break;
        }
        case "update": {
          const d = await load(op.id);
          checkVersion(d, op.ifVersion);
          const n = d.node;
          const back: Editable = {};
          if (op.title !== undefined) ((back.title = n.title), (n.title = checkTitle(op.title)));
          if (op.slug !== undefined) ((back.slug = n.slug), (n.slug = checkSlug(op.slug)));
          if (op.status !== undefined)
            ((back.status = n.status), (n.status = checkStatus(op.status)));
          if (op.tags !== undefined) ((back.tags = n.tags), (n.tags = normalizeTags(op.tags)));
          if (op.fields !== undefined || op.tags !== undefined) {
            const f = checkFields(op.fields ?? n.fields, n.tags);
            if (!f) throw new TreeError("fields must be an object under 8 KB");
            if (op.fields !== undefined) back.fields = n.fields;
            n.fields = f;
          }
          if (op.sort !== undefined) ((back.sort = n.sort), (n.sort = Number(op.sort) || 0));
          if (op.time !== undefined) {
            back.time = n.time;
            n.time = op.time ? checkTime({ ...n.time, ...op.time }, this.tz) : null;
            d.timeDirty = true;
          }
          n.version += 1;
          n.updatedAt = now;
          d.dirty = true;
          inverse.unshift({ op: "update", id: n.id, ifVersion: n.version, ...back });
          events.push({ node: n.id, type: "updated", ancestors: await chain(n.parent) });
          break;
        }
        case "move": {
          const d = await load(op.id);
          checkVersion(d, op.ifVersion);
          const n = d.node;
          const old = await chain(n.parent);
          const next = await chain(op.parent ?? null);
          if (op.parent) await load(op.parent);
          if (op.parent === n.id || next.includes(n.id))
            throw new TreeError("cannot move a node under itself");
          inverse.unshift({
            op: "move",
            id: n.id,
            parent: n.parent,
            sort: n.sort,
            ifVersion: n.version + 1,
          });
          n.parent = op.parent ?? null;
          if (op.sort !== undefined) n.sort = Number(op.sort) || 0;
          n.version += 1;
          n.updatedAt = now;
          d.dirty = true;
          events.push({ node: n.id, type: "moved", ancestors: next, old });
          break;
        }
        case "delete": {
          const d = await load(op.id);
          checkVersion(d, op.ifVersion);
          // The stamp is unique per delete, so a restore brings back exactly the
          // subtree this delete took — not children deleted earlier in the same
          // millisecond. It still sorts by time (the 90-day sweep compares it).
          const stamp = `${now}~${crypto.randomUUID().slice(0, 8)}`;
          for (const id of [op.id, ...(await descendants(op.id, null))]) {
            const x = await load(id, true);
            if (x.deletedAt && id !== op.id) continue;
            x.deletedAt = stamp;
            x.dirty = true;
          }
          d.node.version += 1;
          d.node.updatedAt = now;
          inverse.unshift({ op: "restore", id: op.id, deletedAt: stamp });
          events.push({ node: op.id, type: "deleted", ancestors: await chain(d.node.parent) });
          break;
        }
        case "restore": {
          const d = await load(op.id, true);
          if (!d.deletedAt) throw new TreeError(`node ${op.id} is not deleted`, 409);
          if (d.node.parent) await load(d.node.parent);
          if (d.deletedAt !== op.deletedAt)
            throw new TreeError(`node ${op.id} was deleted again since`, 409);
          for (const id of [op.id, ...(await descendants(op.id, op.deletedAt))]) {
            const x = await load(id, true);
            x.deletedAt = null;
            x.dirty = true;
          }
          d.node.version += 1;
          d.node.updatedAt = now;
          inverse.unshift({ op: "delete", id: op.id });
          events.push({ node: op.id, type: "created", ancestors: await chain(d.node.parent) });
          break;
        }
        default:
          throw new TreeError(`unknown op: ${String((op as { op?: unknown })?.op)}`);
      }
    }

    // ── statements ──
    const stmts: D1StmtLike[] = [];
    for (const d of drafts.values()) {
      if (!d.dirty) continue;
      const n = d.node;
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO nodes (id, user_id, parent_id, slug, title, status, tags, fields, sort, version,
               created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, slug = excluded.slug,
               title = excluded.title, status = excluded.status, tags = excluded.tags,
               fields = excluded.fields, sort = excluded.sort, version = excluded.version,
               updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
             WHERE nodes.user_id = excluded.user_id`,
          )
          .bind(
            n.id,
            this.userId,
            n.parent,
            n.slug,
            n.title,
            n.status,
            JSON.stringify(n.tags),
            JSON.stringify(n.fields),
            n.sort,
            n.version,
            n.createdAt,
            n.updatedAt,
            d.deletedAt,
          ),
      );
      if (d.timeDirty) {
        if (n.time)
          stmts.push(
            this.db
              .prepare(
                `INSERT INTO node_times (node_id, user_id, start_at, end_at, tz, rrule, original_start)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(node_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at,
                   tz = excluded.tz, rrule = excluded.rrule, original_start = excluded.original_start`,
              )
              .bind(
                n.id,
                this.userId,
                n.time.start,
                n.time.end,
                n.time.tz,
                n.time.rrule ?? null,
                n.time.originalStart ?? null,
              ),
          );
        else stmts.push(this.db.prepare(`DELETE FROM node_times WHERE node_id = ?`).bind(n.id));
      }
    }
    const csId = meta.log ? crypto.randomUUID() : null;
    if (csId) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO changesets (id, user_id, summary, ops, inverse, by, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'applied', ?)`,
          )
          .bind(
            csId,
            this.userId,
            meta.summary,
            JSON.stringify(ops),
            JSON.stringify(inverse),
            meta.by,
            now,
          ),
      );
      if (meta.undoes)
        stmts.push(
          this.db
            .prepare(
              `UPDATE changesets SET status = 'undone', undone_at = ? WHERE id = ? AND user_id = ?`,
            )
            .bind(now, meta.undoes, this.userId),
        );
    }
    const top = await this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM node_events WHERE user_id = ?`)
      .bind(this.userId)
      .first<{ s: number }>();
    let seq = Number(top?.s ?? 0);
    for (const e of events)
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO node_events (user_id, seq, node_id, type, ancestors, old_ancestors, changeset_id, by, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            this.userId,
            ++seq,
            e.node,
            e.type,
            JSON.stringify(e.ancestors),
            e.old ? JSON.stringify(e.old) : null,
            csId,
            meta.by,
            now,
          ),
      );

    await (this.db as D1WithBatch).batch(stmts);
    if (!csId) return null;
    return {
      id: csId,
      summary: meta.summary,
      ops,
      inverse,
      by: meta.by,
      status: "applied",
      createdAt: now,
      undoneAt: null,
    };
  }
}
