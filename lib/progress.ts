/**
 * The state tree (docs/state-tree.md): live progress on /dev/roadmap. What a
 * writer posts, what the hub (workers/push/src/progress.ts) keeps, and what
 * the page (app/(app)/dev/roadmap/LiveProgress.tsx) shows — shared so the
 * three agree on the shape and the limits.
 *
 * Everything is a node. A node may be a plain task, have an agent assigned,
 * or be a human (the owner, OWNER_NODE). Every write is an event; the state
 * is the fold of the events (latest per `id`), and `parent` links nodes into
 * a tree (foldProgress). Top-level nodes are page routes ("/words"); their
 * children are paths under them ("/words/prefetch", shown
 * "/words › prefetch"); work that is not a page lives under roots such as
 * "/_infra". A path id's parent is its directory, always.
 */

export const PROGRESS_STATUSES = [
  "doing",
  "blocked",
  "waiting",
  "waiting-owner",
  "review",
  "done",
] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/**
 * "decision" / "approval": pending decisions and authorisations (a repo, a
 * merge, a grant, a secret). "feedback": work that came from a user's or the
 * owner's feedback (a bug report). "person": a human's own node. "group": a
 * plain grouping node, auto-created for a path's missing ancestors.
 */
export const PROGRESS_KINDS = [
  "task",
  "decision",
  "approval",
  "feedback",
  "person",
  "group",
] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

export const ASSIGNEE_TYPES = ["agent", "human"] as const;
export type Assignee = { type: (typeof ASSIGNEE_TYPES)[number]; name: string };

export const PROGRESS_LIMITS = {
  name: 40,
  task: 120,
  note: 280,
  eta: 40,
  late: 200,
  needs: 120,
  who: 40,
  verified: 200,
  id: 120,
  parent: 120,
  ref: 120,
  action: 300,
  link: 300,
} as const;
/** Nodes the hub keeps at most; past it the oldest done ones go first. */
export const PROGRESS_MAX_ENTRIES = 200;
/** Events the hub's append-only log keeps (the newest). */
export const PROGRESS_LOG_MAX = 200;
/** Notes kept per node (the newest); a note appends, never overwrites. */
export const PROGRESS_NOTES_MAX = 20;
/** A done node is pruned this long after its last write. */
export const PROGRESS_DONE_TTL_MS = 24 * 60 * 60 * 1000;
/** The creator of an auto-created node: the first real write claims it. */
export const PROGRESS_AUTO = "_auto";

/**
 * The owner, as a node (kind "person", a human assignee). His to-do items
 * are its children, each with a `ref` to the node it unblocks. Shown under
 * his profile name, looked up when the page renders — the data holds only
 * this id and the name OWNER_NAME.
 */
export const OWNER_NODE = "/@owner";
export const OWNER_NAME = "owner";
export const OWNER_ASSIGNEE: Assignee = { type: "human", name: OWNER_NAME };
export const isOwnerTodo = (id: string) => id.startsWith(`${OWNER_NODE}/`);
const isOwnerSubtree = (id: string) => id === OWNER_NODE || isOwnerTodo(id);

/**
 * What a writer posts. `id` is stable (default: a slug of assignee and
 * task); `parent` another node's id (derived for a path id); `assignee` is
 * who works on it (`agent: "<name>"` is the alias for an agent assignee) and
 * also names the writer; `needs` is what the owner must do ("" clears it);
 * `ref` (an owner to-do) the node it unblocks; `action` the exact command or
 * URL that does it; `note` is appended to the node's notes; `rev`, if given,
 * must be above the node's current rev (else 409).
 */
export type ProgressReport = {
  id: string;
  parent?: string;
  assignee: Assignee;
  task: string;
  status: ProgressStatus;
  kind?: ProgressKind;
  pct?: number;
  /**
   * The agent's estimate as written: a duration from now ("15m", "1h30m"),
   * an ISO time, or free text. A duration or a time sets `etaAt`; free text
   * clears it (no bar, no ping). Every report that carries it revises it.
   */
  eta?: string;
  /** When the estimate runs out (ms): sent as is, or worked out by the hub from `eta`. */
  etaAt?: number;
  /** `eta` as a duration (ms): the hub adds it to its own clock (parseProgressReport sets it). */
  etaIn?: number;
  /**
   * A range's start ("--eta 12m-63m": P5 of what it may take; `etaAt` / `etaIn`
   * is its P95). As a time, or a duration the hub adds to its clock. Overdue,
   * the ETA ping and the overrun rule all count from the P95; the P5 only
   * draws (the solid bar, then a fading tail) and labels ("12–63M").
   */
  etaMinAt?: number;
  etaMinIn?: number;
  /**
   * `progress.ts --confirm`: the estimate still holds. No new time; the hub
   * logs a "confirm" event and stamps etaConfirmedAt. Before the ETA only
   * (a passed one needs a new --eta with --late).
   */
  confirm?: boolean;
  /**
   * One action across several nodes (`progress.ts batch`, or `--change-id`
   * on each call): their ETA events share this id and one timestamp, so the
   * Gantt's ticks line up and a tap shows the group.
   */
  changeId?: string;
  /**
   * Why the task ran past its estimate (`progress.ts --late "…"`), always with
   * a new estimate that sets a time. The hub stores it as `lateReason` and
   * posts the owner the reason and the new time (docs/state-tree.md, "ETA
   * overrun"). Once a node's etaAt has passed, a new estimate without it is
   * refused.
   */
  late?: string;
  pr?: number;
  /** More PRs at once (`--pr 703,707`); every PR a node ever named is kept in its `prs`. */
  prs?: number[];
  needs?: string;
  /**
   * Who can unblock it now (`--who`), with status blocked: "owner" or a lane
   * name. The hub nudges that one with backoff until it is no longer blocked
   * (docs/state-tree.md, "Blocked and paused"). "" clears it.
   */
  who?: string;
  /**
   * How a done node was done (docs/state-tree.md, "Done kinds"): `verified`
   * is the evidence (a merged and deployed PR, a test or screenshot link);
   * `unverified` says it is done but not confirmed (the hub then adds a
   * "verify: <name>" child for the same lane). Status done only; one or neither.
   */
  verified?: string;
  unverified?: boolean;
  ref?: string;
  action?: string;
  /** A page about it (a PR, a preview): https only. */
  link?: string;
  note?: string;
  rev?: number;
  /**
   * When it really went done (ms), for a done node written after the fact
   * (moving old work into the tree); the root token only, never in the stats.
   */
  endedAt?: number;
};
export type ProgressNote = { at: number; by: string; text: string };
/** How a done node was done (docs/state-tree.md, "Done kinds"). */
export type ProgressDoneKind = "verified" | "unverified";
/** `--who`: "owner" or a lane name (an "@" in front is dropped). */
export const WHO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A receipt code on an "ETA reached" line (`progress.ts ack <code>`). */
export const RECEIPT_RE = /^[a-z0-9]{6}$/;
/** A fresh receipt code: six of a–z 0–9. */
export function newReceiptCode(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => abc[b % 36]).join("");
}

/**
 * The "verify: <name>" child a node done --unverified gets (docs/state-tree.md,
 * "Done kinds"): a path's `<id>/verify`, a slug's `<id>.verify`; undefined
 * when that would be too long or the node is itself a verify node.
 */
export function verifyIdOf(id: string): string | undefined {
  if (/[/.]verify$/.test(id)) return undefined;
  const v = isPathId(id) ? `${id}/verify` : `${id}.verify`;
  return isProgressId(v) ? v : undefined;
}
/**
 * A node as the hub keeps it. `creator` wrote it first (and so may change
 * its status, pct and eta), `by` wrote it last, `rev` is its revision,
 * `created` / `at` when it was first / last written.
 */
export type ProgressEntry = Omit<
  ProgressReport,
  | "note"
  | "rev"
  | "kind"
  | "etaIn"
  | "etaMinIn"
  | "late"
  | "confirm"
  | "changeId"
  | "verified"
  | "unverified"
> & {
  kind: ProgressKind;
  /** A done node: verified (with `evidence`) or done but not confirmed. None: done before kinds existed. */
  doneKind?: ProgressDoneKind;
  evidence?: string;
  /** The last write that set or re-confirmed the estimate (a change or a confirm). */
  etaConfirmedAt?: number;
  /** etaConfirmedAt as "5 min ago", added by the hub when it answers or sends (never stored). */
  etaConfirmedAgo?: string;
  /** The estimate's history: changes, confirms and status changes, oldest first (PROGRESS_ETA_EVENTS_MAX). */
  etaEvents?: EtaEvent[];
  /**
   * The original plan: the start and the estimate when the node first got a
   * time. Never moves; the Gantt draws it as a faint ghost bar.
   */
  plan?: { start: number; etaAt: number; etaMinAt?: number };
  /**
   * The `etaAt` the hub already sent its ping for ("ETA reached for …",
   * workers/push/src/progress.ts fireEta). A revised `etaAt` differs, so it
   * pings again at the new time.
   */
  etaSent?: number;
  /**
   * The `etaAt` the hub already told the owner about as unexplained ("<name>
   * 超时，未说明原因": pinged, then ETA_EXPLAIN_MS without a reason or a new
   * estimate). Once per etaAt, as etaSent.
   */
  etaSilent?: number;
  /**
   * Receipts (docs/state-tree.md, "Receipts"), all for the estimate `etaSent`:
   * the code the "ETA reached" line carried, when a listener got it
   * (`etaHeardAt`; no listener: `etaQueued` = that etaAt, the clock not
   * started), the etaAt acked (`progress.ts ack <code>` or any report on the
   * node) and the etaAt the coordinating lane was told about.
   */
  etaCode?: string;
  etaQueued?: number;
  etaHeardAt?: number;
  etaAcked?: number;
  etaMain?: number;
  /** After "未说明原因": repeats sent (`silentN`) and when the next is due, with backoff. */
  silentN?: number;
  silentAt?: number;
  /** Blocked on someone (`who`): the who+needs being nudged, nudges sent, the next one. */
  nudgeFor?: string;
  nudgeN?: number;
  nudgeAt?: number;
  /** A nudge for a lane that found no listener: sent when one connects (not by the alarm). */
  nudgeQueued?: number;
  /**
   * Waiting on the owner (lib/owner-wait.ts; docs/state-tree.md, "Waiting on
   * the owner"): reminders sent for the estimate `remindFor` (its etaAt), and
   * when the next one is due. A new etaAt makes them stale: it starts over.
   */
  remindFor?: number;
  remindN?: number;
  remindAt?: number;
  /** The last overrun's reason (`--late`), and the etaAt it explained. */
  lateReason?: string;
  lateFor?: number;
  /** Every PR the node has named (`pr`, `prs`), oldest first, at most PROGRESS_PRS_MAX. */
  prs?: number[];
  creator: string;
  by: string;
  rev: number;
  created: number;
  at: number;
  notes?: ProgressNote[];
  /**
   * Timing, for agents calibrating their ETAs (`progress.ts stats`); never
   * shown to the owner. `startedAt`: the first write with status doing.
   * `endedAt`: when it went done (cleared if it reopens). `estimateMs`: the
   * first estimate that set a time, as a duration from when it was given;
   * `etaRevisions`: how many estimates came after it (etaAt keeps moving).
   */
  startedAt?: number;
  endedAt?: number;
  estimateMs?: number;
  etaRevisions?: number;
};
/**
 * One entry of a node's ETA history (docs/state-tree.md, "ETA history").
 * "change": a new estimate (old → new; no newEtaAt = cleared by free text);
 * "confirm": the estimate re-confirmed unchanged; "status": the status
 * changed. `changeId` groups the events one action made across nodes (they
 * share `at` too).
 */
export type EtaEvent = {
  at: number;
  kind: "change" | "confirm" | "status";
  oldEtaAt?: number;
  newEtaAt?: number;
  oldEtaMinAt?: number;
  newEtaMinAt?: number;
  status?: ProgressStatus;
  by: string;
  changeId: string;
};
/** ETA events a node keeps (the newest). */
export const PROGRESS_ETA_EVENTS_MAX = 24;
/** A change id: what `--change-id` takes. */
export const CHANGE_ID_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/** One write as broadcast and logged: the node after it (without its notes) and the note it added. */
export type ProgressEvent = { type: "progress"; note?: string } & Omit<ProgressEntry, "notes">;

/**
 * What the hub sends a reader: the state and the log on connect (and after a
 * prune or an eviction), then each event as it happens.
 */
export type ProgressMessage =
  | { type: "snapshot"; entries: ProgressEntry[]; log: ProgressEvent[] }
  | ProgressEvent;

/** Slugs ("liveroad-live-roadmap") and paths ("/words/prefetch", "/_infra", "/@owner/x"). */
const ID_RE = /^(?:[a-z0-9][a-z0-9._:-]*|(?:\/@?[a-z0-9_][a-z0-9._:-]*)+)$/;
export const isProgressId = (id: unknown): id is string =>
  typeof id === "string" && id.length <= PROGRESS_LIMITS.id && ID_RE.test(id);

export const isPathId = (id: string) => id.startsWith("/");
/** A path id's parent: its directory ("/words/prefetch" → "/words"; "/words" → none). */
export const pathParent = (id: string) =>
  isPathId(id) && id.lastIndexOf("/") > 0 ? id.slice(0, id.lastIndexOf("/")) : undefined;

/** "/words/prefetch" → "/words › prefetch"; a slug stays as it is. */
export function progressLabel(id: string): string {
  if (!isPathId(id)) return id;
  const [first, ...rest] = id.slice(1).split("/");
  return [`/${first}`, ...rest].join(" › ");
}

/** The default id: a slug of the assignee and the task. */
export function progressSlug(name: string, task: string): string {
  return `${name}-${task}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** The storage key of one node. */
export const progressKey = (e: { id: string }) => `e:${e.id}`;

// Control characters (newlines included) collapse to a space.
// oxlint-disable-next-line no-control-regex
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

type Field = keyof typeof PROGRESS_LIMITS;
function text(v: unknown, field: Field): string | undefined | Error {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return new Error(`${field} must be a string`);
  const s = clean(v);
  if (s.length > PROGRESS_LIMITS[field])
    return new Error(`${field} is longer than ${PROGRESS_LIMITS[field]} characters`);
  return s;
}

/** `assignee: {type, name}`, or its alias `agent: "<name>"`. */
function parseAssignee(b: Record<string, unknown>): Assignee | Error {
  if (b.assignee !== undefined && b.assignee !== null) {
    const a = b.assignee as Record<string, unknown>;
    if (typeof a !== "object" || !ASSIGNEE_TYPES.includes(a.type as Assignee["type"]))
      return new Error(`assignee must be {type: ${ASSIGNEE_TYPES.join("|")}, name}`);
    const name = text(a.name, "name");
    if (name instanceof Error) return new Error(`assignee.${name.message}`);
    if (!name) return new Error("assignee.name is required");
    return { type: a.type as Assignee["type"], name };
  }
  const name = text(b.agent, "name");
  if (name instanceof Error) return new Error(`agent: ${name.message}`);
  if (!name) return new Error("assignee (or agent) is required");
  return { type: "agent", name };
}

/** A report from a writer, checked field by field. An Error says what is wrong. */
export function parseProgressReport(body: unknown): ProgressReport | Error {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return new Error("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const f: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(PROGRESS_LIMITS) as Field[]) {
    if (field === "name") continue;
    const v = text(b[field], field);
    if (v instanceof Error) return v;
    if (v !== undefined) f[field] = v;
  }
  const assignee = parseAssignee(b);
  if (assignee instanceof Error) return assignee;
  if (!f.task) return new Error("task is required");
  if (!PROGRESS_STATUSES.includes(b.status as ProgressStatus))
    return new Error(`status must be one of ${PROGRESS_STATUSES.join(", ")}`);
  if (b.kind !== undefined && !PROGRESS_KINDS.includes(b.kind as ProgressKind))
    return new Error(`kind must be one of ${PROGRESS_KINDS.join(", ")}`);
  for (const k of ["id", "parent", "ref"] as const)
    if (f[k] && !isProgressId(f[k]))
      return new Error(`${k} must be a slug or a /path (a-z, 0-9, . _ : -)`);
  const id = f.id || progressSlug(assignee.name, f.task);
  if (!id) return new Error("id is required when the name and task have no letters or digits");
  let parent = f.parent || undefined;
  if (isPathId(id)) {
    const dir = pathParent(id);
    if (parent !== undefined && parent !== dir)
      return new Error(`a path's parent is its directory (${dir ?? "none"}), not ${parent}`);
    parent = dir;
  }
  if (parent === id) return new Error("parent must not be the node itself");

  const out: ProgressReport = { id, assignee, task: f.task, status: b.status as ProgressStatus };
  if (parent) out.parent = parent;
  if (b.kind !== undefined) out.kind = b.kind as ProgressKind;
  if (b.pct !== undefined && b.pct !== null) {
    if (typeof b.pct !== "number" || !Number.isFinite(b.pct) || b.pct < 0 || b.pct > 100)
      return new Error("pct must be a number from 0 to 100");
    out.pct = Math.round(b.pct);
  }
  if (b.prs !== undefined && b.prs !== null) {
    const ok = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
    if (!Array.isArray(b.prs) || b.prs.length > PROGRESS_PRS_MAX || !b.prs.every(ok))
      return new Error(`prs must be at most ${PROGRESS_PRS_MAX} positive integers`);
    if (b.prs.length) out.prs = [...new Set(b.prs as number[])];
  }
  for (const k of ["pr", "rev"] as const)
    if (b[k] !== undefined && b[k] !== null) {
      const n = b[k];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER)
        return new Error(`${k} must be a positive integer`);
      out[k] = n;
    }
  if (f.link) {
    if (!/^https:\/\/\S+$/.test(f.link)) return new Error("link must be an https:// URL");
    out.link = f.link;
  }
  if (f.needs !== undefined) out.needs = f.needs;
  if (f.who !== undefined) {
    const who = f.who.replace(/^@/, "");
    if (who && !WHO_RE.test(who)) return new Error('who must be "owner" or a lane name');
    out.who = who;
  }
  if (b.unverified !== undefined && b.unverified !== null && b.unverified !== false) {
    if (b.unverified !== true) return new Error("unverified must be true");
    out.unverified = true;
  }
  if (f.verified !== undefined || out.unverified) {
    if (out.status !== "done") return new Error("--verified / --unverified go with --done");
    if (f.verified !== undefined && out.unverified)
      return new Error("--verified and --unverified: one or the other");
    if (f.verified !== undefined && !f.verified)
      return new Error('--verified needs the evidence: --verified "PR #812 merged and deployed"');
    if (f.verified) out.verified = f.verified;
  }
  for (const k of ["eta", "ref", "action", "note", "late"] as const) if (f[k]) out[k] = f[k];
  if (b.etaAt !== undefined && b.etaAt !== null) {
    if (typeof b.etaAt !== "number" || !Number.isInteger(b.etaAt) || b.etaAt <= 0)
      return new Error("etaAt must be a time in milliseconds");
    out.etaAt = b.etaAt;
  } else if (out.eta) {
    const e = parseEta(out.eta);
    if (e && "in" in e) {
      out.etaIn = e.in;
      if (e.min !== undefined) out.etaMinIn = e.min;
    } else if (e) out.etaAt = e.at;
  }
  if (b.etaMinAt !== undefined && b.etaMinAt !== null) {
    if (typeof b.etaMinAt !== "number" || !Number.isInteger(b.etaMinAt) || b.etaMinAt <= 0)
      return new Error("etaMinAt must be a time in milliseconds");
    if (out.etaAt === undefined || b.etaMinAt > out.etaAt)
      return new Error("etaMinAt (P5) needs an etaAt (P95) at or after it");
    if (b.etaMinAt < out.etaAt) out.etaMinAt = b.etaMinAt;
  }
  if (b.confirm !== undefined && b.confirm !== null && b.confirm !== false) {
    if (b.confirm !== true) return new Error("confirm must be true");
    if (out.eta !== undefined || out.etaAt !== undefined)
      return new Error("confirm keeps the estimate as it is: give it without --eta");
    out.confirm = true;
  }
  if (b.changeId !== undefined && b.changeId !== null) {
    if (typeof b.changeId !== "string" || !CHANGE_ID_RE.test(b.changeId))
      return new Error("changeId must be 1–40 of A-Z a-z 0-9 . _ : -");
    out.changeId = b.changeId;
  }
  if (b.endedAt !== undefined && b.endedAt !== null) {
    if (typeof b.endedAt !== "number" || !Number.isInteger(b.endedAt) || b.endedAt <= 0)
      return new Error("endedAt must be a time in milliseconds");
    if (out.status !== "done") return new Error("endedAt is only for a done node");
    out.endedAt = b.endedAt;
  }
  if (out.late && out.etaAt === undefined && out.etaIn === undefined)
    return new Error(
      'late needs a new estimate that sets a time: --eta 20m --late "why it ran over"',
    );
  return out;
}

/**
 * The node a report makes, given what was there (`prev`). The first real
 * write claims an auto-created node; the owner's subtree is always his,
 * assigned to him; a note is appended; `needs: ""` clears it.
 */
export function mergeProgress(
  prev: ProgressEntry | undefined,
  r: ProgressReport,
  at: number,
  /** The action's change id and time (the hub's; shared by a batch). Default: this write's own. */
  change: { id?: string; at?: number } = {},
): ProgressEntry {
  const claim = !prev || prev.creator === PROGRESS_AUTO;
  const pick = <K extends "pct" | "eta" | "pr" | "ref" | "action" | "link">(k: K) =>
    r[k] ?? prev?.[k];
  const needs = r.needs === undefined ? prev?.needs : r.needs || undefined;
  // A new estimate replaces the old one; free text clears the time; none keeps it.
  const etaAt =
    r.etaAt ??
    (r.etaIn !== undefined ? at + r.etaIn : r.eta !== undefined ? undefined : prev?.etaAt);
  // A range's P5 comes and goes with its estimate: one number has none.
  const newEstimate = r.eta !== undefined || r.etaAt !== undefined || r.etaIn !== undefined;
  const etaMinAt = newEstimate
    ? (r.etaMinAt ?? (r.etaMinIn !== undefined ? at + r.etaMinIn : undefined))
    : prev?.etaMinAt;
  const notes = [...(prev?.notes ?? [])];
  if (r.note) notes.push({ at, by: r.assignee.name, text: r.note });
  const entry: ProgressEntry = {
    id: r.id,
    assignee: isOwnerSubtree(r.id) ? OWNER_ASSIGNEE : claim ? r.assignee : prev.assignee,
    task: r.task,
    status: r.status,
    kind: r.id === OWNER_NODE ? "person" : (r.kind ?? (claim || !prev ? "task" : prev.kind)),
    creator: claim ? r.assignee.name : prev.creator,
    by: r.assignee.name,
    rev: r.rev ?? (prev?.rev ?? 0) + 1,
    created: prev?.created ?? at,
    at,
  };
  const parent = r.parent ?? prev?.parent;
  if (parent) entry.parent = parent;
  for (const k of ["pct", "eta", "pr", "ref", "action", "link"] as const) {
    const v = pick(k);
    if (v !== undefined) (entry as Record<string, unknown>)[k] = v;
  }
  const prs = mergePrs(prev?.prs ?? (prev?.pr ? [prev.pr] : []), [
    ...(r.prs ?? []),
    ...(r.pr ? [r.pr] : []),
  ]);
  if (prs.length) entry.prs = prs;
  if (needs) entry.needs = needs;
  const who = r.who === undefined ? prev?.who : r.who || undefined;
  if (who) entry.who = who;
  if (r.status === "done") {
    if (r.verified) {
      entry.doneKind = "verified";
      entry.evidence = r.verified;
    } else if (r.unverified) entry.doneKind = "unverified";
    else if (prev?.status === "done" && prev.doneKind) {
      entry.doneKind = prev.doneKind;
      if (prev.evidence) entry.evidence = prev.evidence;
    }
  }
  if (etaAt !== undefined) entry.etaAt = etaAt;
  if (etaAt !== undefined && etaMinAt !== undefined && etaMinAt < etaAt) entry.etaMinAt = etaMinAt;
  etaHistory(prev, r, entry, at, change);
  if (prev?.etaSent !== undefined) entry.etaSent = prev.etaSent;
  if (prev?.etaSilent !== undefined) entry.etaSilent = prev.etaSilent;
  for (const k of [
    "etaCode",
    "etaQueued",
    "etaHeardAt",
    "etaAcked",
    "etaMain",
    "silentN",
    "silentAt",
  ] as const)
    if (prev?.[k] !== undefined) (entry as Record<string, unknown>)[k] = prev[k];
  if (prev?.nudgeFor !== undefined && prev.nudgeFor === nudgeKey(entry)) {
    entry.nudgeFor = prev.nudgeFor;
    if (prev.nudgeN !== undefined) entry.nudgeN = prev.nudgeN;
    if (prev.nudgeAt !== undefined) entry.nudgeAt = prev.nudgeAt;
    if (prev.nudgeQueued !== undefined) entry.nudgeQueued = prev.nudgeQueued;
  }
  if (prev?.remindFor !== undefined && prev.remindFor === entry.etaAt) {
    entry.remindFor = prev.remindFor;
    if (prev.remindN !== undefined) entry.remindN = prev.remindN;
    if (prev.remindAt !== undefined) entry.remindAt = prev.remindAt;
  }
  if (r.late) {
    entry.lateReason = r.late;
    if (prev?.etaAt !== undefined) entry.lateFor = prev.etaAt;
    notes.push({ at, by: r.assignee.name, text: `late: ${r.late}` });
  } else if (prev?.lateReason !== undefined) {
    entry.lateReason = prev.lateReason;
    if (prev.lateFor !== undefined) entry.lateFor = prev.lateFor;
  }
  if (notes.length) entry.notes = notes.slice(-PROGRESS_NOTES_MAX);
  const startedAt = prev?.startedAt ?? (r.status === "doing" ? at : undefined);
  if (startedAt !== undefined) entry.startedAt = startedAt;
  if (r.status === "done")
    entry.endedAt = r.endedAt ?? (prev?.status === "done" ? (prev.endedAt ?? at) : at);
  // An estimate that sets a time: the first is kept, the later ones counted.
  const estimate = r.etaIn ?? (r.etaAt !== undefined ? r.etaAt - at : undefined);
  if (prev?.estimateMs !== undefined) {
    entry.estimateMs = prev.estimateMs;
    entry.etaRevisions = (prev.etaRevisions ?? 0) + (estimate !== undefined ? 1 : 0);
  } else if (estimate !== undefined && estimate > 0) {
    entry.estimateMs = estimate;
    entry.etaRevisions = 0;
  }
  return entry;
}

/** A change id when the writer gave none: base36 time and a random tail. */
export const newChangeId = (at: number) =>
  `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The ETA history a write adds to `entry` (mergeProgress): a "change" when
 * the estimate moved (or was set, or cleared by free text), a "confirm" for
 * `confirm`, a "status" when the status changed; `etaConfirmedAt` on a change
 * that sets a time or a confirm; `plan` once, from the first time set.
 */
function etaHistory(
  prev: ProgressEntry | undefined,
  r: ProgressReport,
  entry: ProgressEntry,
  at: number,
  change: { id?: string; at?: number },
) {
  const events = [...(prev?.etaEvents ?? [])];
  const changeId = change.id ?? newChangeId(at);
  const when = change.at ?? at;
  const base = { at: when, by: r.assignee.name, changeId };
  const newEstimate = r.eta !== undefined || r.etaAt !== undefined || r.etaIn !== undefined;
  const moved = entry.etaAt !== prev?.etaAt || entry.etaMinAt !== prev?.etaMinAt;
  let confirmed = false;
  if (newEstimate && moved) {
    const ev: EtaEvent = { ...base, kind: "change" };
    if (prev?.etaAt !== undefined) ev.oldEtaAt = prev.etaAt;
    if (entry.etaAt !== undefined) ev.newEtaAt = entry.etaAt;
    if (prev?.etaMinAt !== undefined) ev.oldEtaMinAt = prev.etaMinAt;
    if (entry.etaMinAt !== undefined) ev.newEtaMinAt = entry.etaMinAt;
    events.push(ev);
    confirmed = entry.etaAt !== undefined;
  } else if ((newEstimate || r.confirm) && entry.etaAt !== undefined) {
    // Confirmed, or the same time given again: it holds.
    events.push({ ...base, kind: "confirm", newEtaAt: entry.etaAt });
    confirmed = true;
  }
  if (prev && prev.status !== entry.status)
    events.push({ ...base, kind: "status", status: entry.status });
  if (events.length) entry.etaEvents = events.slice(-PROGRESS_ETA_EVENTS_MAX);
  const confirmedAt = confirmed
    ? when
    : entry.etaAt !== undefined
      ? prev?.etaConfirmedAt
      : undefined;
  if (confirmedAt !== undefined) entry.etaConfirmedAt = confirmedAt;
  if (prev?.plan) entry.plan = prev.plan;
  else if (entry.etaAt !== undefined) {
    const start = Math.min(prev?.startedAt ?? prev?.created ?? at, entry.etaAt);
    entry.plan = {
      start,
      etaAt: entry.etaAt,
      ...(entry.etaMinAt !== undefined ? { etaMinAt: entry.etaMinAt } : {}),
    };
  }
}

/** A node keeps at most this many PR numbers (the newest). */
export const PROGRESS_PRS_MAX = 20;

/** `a` then the numbers of `b` not in it, newest PROGRESS_PRS_MAX kept. */
export function mergePrs(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].slice(-PROGRESS_PRS_MAX);
}

/** The PRs a node names: its `prs` (else `pr`), then any "#123" in its title. */
export function prsOf(e: Pick<ProgressEntry, "pr" | "prs" | "task">): number[] {
  const inTitle = [...e.task.matchAll(/(?:^|[^\w&])#(\d{1,6})\b/g)].map((m) => Number(m[1]));
  return mergePrs(e.prs ?? (e.pr ? [e.pr] : []), inTitle);
}

/**
 * One done node in the hub's durable history (docs/state-tree.md, "Done
 * history"): what /dev/roadmap lists as done, kept after the live tree drops
 * the node (PROGRESS_DONE_TTL_MS). One record per id: done again, it is
 * replaced. Kept with no expiry; see PROGRESS_HISTORY_SEND_MAX for reads.
 */
export type ProgressHistory = {
  id: string;
  title: string;
  /** Who did it: the creator (the last writer for an auto group). */
  agent: string;
  kind: ProgressKind;
  parent?: string;
  prs?: number[];
  link?: string;
  created: number;
  startedAt?: number;
  endedAt: number;
  /** The first estimate that set a time (ms), as in the stats log. */
  estimateMs?: number;
  /** Verified (with `evidence`) or not confirmed; none: done before kinds existed. */
  doneKind?: ProgressDoneKind;
  evidence?: string;
};
/** A reader gets at most this many history records per ask (the newest). */
export const PROGRESS_HISTORY_SEND_MAX = 2000;
/** …and this many when it does not say. */
export const PROGRESS_HISTORY_SEND_DEFAULT = 500;
export const historyKey = (id: string) => `h:${id}`;

/** A node that went done → its history record. */
export function progressHistory(e: ProgressEntry): ProgressHistory {
  const out: ProgressHistory = {
    id: e.id,
    title: e.task,
    agent: e.creator === PROGRESS_AUTO ? e.by : e.creator,
    kind: e.kind,
    created: e.created,
    endedAt: e.endedAt ?? e.at,
  };
  if (e.parent) out.parent = e.parent;
  const prs = prsOf(e);
  if (prs.length) out.prs = prs;
  if (e.link) out.link = e.link;
  if (e.startedAt !== undefined) out.startedAt = e.startedAt;
  if (e.estimateMs !== undefined) out.estimateMs = e.estimateMs;
  if (e.doneKind) out.doneKind = e.doneKind;
  if (e.evidence) out.evidence = e.evidence;
  return out;
}

/** A stats-log record (older than the history) as a history record: no PRs, no parent known. */
export function historyFromDone(d: ProgressDone): ProgressHistory {
  const out: ProgressHistory = {
    id: d.id,
    title: d.title,
    agent: d.agent,
    kind: "task",
    created: d.at - d.actualMs,
    endedAt: d.at,
  };
  if (isPathId(d.id)) {
    const parent = pathParent(d.id);
    if (parent) out.parent = parent;
  }
  if (d.estimateMs !== undefined) out.estimateMs = d.estimateMs;
  return out;
}

/** History records, newest first, at most `limit`. */
export function newestHistory(
  records: Iterable<ProgressHistory>,
  limit = PROGRESS_HISTORY_SEND_DEFAULT,
): ProgressHistory[] {
  const n = Math.max(1, Math.min(PROGRESS_HISTORY_SEND_MAX, Math.floor(limit) || 1));
  return [...records].sort((a, b) => b.endedAt - a.endedAt).slice(0, n);
}

/** One done task, as the hub's durable stats log keeps it (PROGRESS_STATS_TTL_MS). */
export type ProgressDone = {
  at: number;
  agent: string;
  id: string;
  title: string;
  estimateMs?: number;
  actualMs: number;
  revisions: number;
};
/** The stats log keeps done tasks this long… */
export const PROGRESS_STATS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** …and at most this many (the newest). */
export const PROGRESS_STATS_MAX = 1000;

/** A node that just went done → its stats record (from its start, else its creation, to its end). */
export function progressDone(e: ProgressEntry): ProgressDone {
  const end = e.endedAt ?? e.at;
  const out: ProgressDone = {
    at: end,
    agent: e.creator === PROGRESS_AUTO ? e.by : e.creator,
    id: e.id,
    title: e.task,
    actualMs: Math.max(0, end - (e.startedAt ?? e.created)),
    revisions: e.etaRevisions ?? 0,
  };
  if (e.estimateMs !== undefined) out.estimateMs = e.estimateMs;
  return out;
}

export type ProgressAgentStats = {
  agent: string;
  done: number;
  /** Done tasks that had an estimate. */
  estimated: number;
  /** Median of actual / estimate over the estimated ones (1 = on time, 2 = took twice as long). */
  medianRatio?: number;
  tasks: ProgressDone[];
};

/** Per agent (most done first): the done tasks since `since`, and the median actual/estimate ratio. */
export function progressStats(
  records: Iterable<ProgressDone>,
  opts: { agent?: string; since?: number } = {},
): ProgressAgentStats[] {
  const by = new Map<string, ProgressDone[]>();
  for (const d of records) {
    if (opts.agent !== undefined && d.agent !== opts.agent) continue;
    if (opts.since !== undefined && d.at < opts.since) continue;
    by.set(d.agent, [...(by.get(d.agent) ?? []), d]);
  }
  return [...by]
    .map(([agent, tasks]) => {
      const ratios = tasks
        .filter((d) => d.estimateMs)
        .map((d) => d.actualMs / d.estimateMs!)
        .sort((a, b) => a - b);
      const mid = ratios.length >> 1;
      const out: ProgressAgentStats = {
        agent,
        done: tasks.length,
        estimated: ratios.length,
        tasks: tasks.sort((a, b) => a.at - b.at),
      };
      if (ratios.length)
        out.medianRatio = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
      return out;
    })
    .sort((a, b) => b.done - a.done || a.agent.localeCompare(b.agent));
}

/**
 * The widest name a task title may start with ("name: description"), in
 * display columns (CJK and other full-width characters count 2, so about 10
 * Chinese characters); the ETA bar shows only the name.
 */
export const PROGRESS_TITLE_NAME_MAX = 20;

const segments = (s: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map(
        (x) => x.segment,
      )
    : [...s];
/** Characters as a reader counts them (graphemes, not bytes or code units). */
export const graphemeCount = (s: string) => segments(s).length;

/**
 * East Asian Width W or F (Unicode UAX #11), and emoji presentation: two
 * columns. The ranges cover Hangul Jamo, CJK (radicals to Yi, compatibility
 * ideographs and forms), Hangul syllables, full-width forms, and the wide
 * emoji and supplementary ideograph planes.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

const isWide = (cp: number) => {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
};

/**
 * How many terminal columns `s` takes: per grapheme, 2 when it is wide (East
 * Asian Width W/F, or an emoji shown as one: VS16 or a ZWJ sequence), else 1;
 * a grapheme of only combining or control characters takes none.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const g of segments(s)) {
    const cps = [...g].map((c) => c.codePointAt(0)!);
    // Control, combining marks (U+0300–036F) and zero-width characters (U+200B–200F): none.
    if (
      cps.every(
        (c) => c < 0x20 || c === 0x7f || (c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f),
      )
    )
      continue;
    // VS16 (U+FE0F) or a ZWJ (U+200D) makes an emoji picture: two columns.
    w += isWide(cps[0]!) || cps.includes(0xfe0f) || cps.includes(0x200d) ? 2 : 1;
  }
  return w;
}

/** The name of a title ("name: description"; ':' or '：'); undefined when there is no colon. */
export const titleName = (task: string): string | undefined => {
  const i = task.search(/[:：]/);
  return i < 0 ? undefined : task.slice(0, i).trim();
};

/**
 * A task title is "name: description" (ASCII ':' or full-width '：'): the
 * owner's ETA bar shows only the name, the full list both. With a colon, the
 * name must be 1–PROGRESS_TITLE_NAME_MAX display columns (displayWidth: a
 * Chinese character is 2): an Error. Without one, a title wider than that is
 * still taken, with a warning. `prevTask`: the node's current title — a name
 * it already has is never refused (nodes from before the column rule keep
 * theirs); only a new or renamed one is checked.
 */
export function checkTaskTitle(task: string, prevTask?: string): { warning?: string } | Error {
  const name = titleName(task);
  const example = `e.g. --task "Swipe fix: the card snaps back" or --task "滑动修复：短拖回弹" (a Chinese character is 2 columns: at most about 10)`;
  if (name === undefined)
    return displayWidth(task.trim()) > PROGRESS_TITLE_NAME_MAX
      ? {
          warning: `task titles are "name: description" — the ETA bar shows only the name (at most ${PROGRESS_TITLE_NAME_MAX} columns); ${example}`,
        }
      : {};
  if (prevTask !== undefined && titleName(prevTask) === name) return {};
  const n = displayWidth(name);
  if (n < 1 || n > PROGRESS_TITLE_NAME_MAX)
    return new Error(
      `the name before the colon in --task must be 1–${PROGRESS_TITLE_NAME_MAX} columns wide (it is ${n}): the ETA bar shows only the name; ${example}`,
    );
  return {};
}

/** A node created only because a descendant named it: a group (or the owner's person node). */
export function autoNode(id: string, by: string, at: number): ProgressEntry {
  const owner = id === OWNER_NODE;
  const entry: ProgressEntry = {
    id,
    assignee: owner ? OWNER_ASSIGNEE : { type: "agent", name: by },
    task: owner ? OWNER_NAME : id.slice(id.lastIndexOf("/") + 1),
    status: "doing",
    kind: owner ? "person" : "group",
    creator: PROGRESS_AUTO,
    by,
    rev: 1,
    created: at,
    at,
  };
  const parent = pathParent(id);
  if (parent) entry.parent = parent;
  return entry;
}

/** The event a write broadcasts: the node without its notes, and the note it added. */
export function progressEvent(entry: ProgressEntry, note?: string): ProgressEvent {
  const { notes: _notes, ...rest } = entry;
  return { type: "progress", ...rest, ...(note ? { note } : {}) };
}

const isEntry = (e: unknown): e is ProgressEntry => {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  const a = x.assignee as Record<string, unknown> | undefined;
  return (
    typeof x.id === "string" &&
    !!a &&
    typeof a.name === "string" &&
    ASSIGNEE_TYPES.includes(a.type as Assignee["type"]) &&
    typeof x.task === "string" &&
    PROGRESS_STATUSES.includes(x.status as ProgressStatus) &&
    PROGRESS_KINDS.includes(x.kind as ProgressKind) &&
    typeof x.at === "number"
  );
};

/** A reader's view of a hub message; anything else is null. */
export function parseProgressMessage(raw: unknown): ProgressMessage | null {
  let m: unknown;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, unknown>;
  if (msg.type === "snapshot" && Array.isArray(msg.entries))
    return {
      type: "snapshot",
      entries: msg.entries.filter(isEntry),
      log: (Array.isArray(msg.log) ? msg.log : []).filter(isEntry) as ProgressEvent[],
    };
  if (msg.type === "progress" && isEntry(msg)) return msg as unknown as ProgressEvent;
  return null;
}

/** The hub's answer to a reader's {type:"history"}: sent to that reader only. */
export type ProgressHistoryMessage = { type: "history"; items: ProgressHistory[]; total: number };

const isHistory = (h: unknown): h is ProgressHistory => {
  if (!h || typeof h !== "object") return false;
  const x = h as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    typeof x.agent === "string" &&
    typeof x.endedAt === "number" &&
    (x.prs === undefined || (Array.isArray(x.prs) && x.prs.every((n) => typeof n === "number")))
  );
};

/** A history answer from the hub; anything else (a snapshot, an event) is null. */
export function parseHistoryMessage(raw: unknown): ProgressHistoryMessage | null {
  let m: unknown;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  const msg = m as Record<string, unknown> | null;
  if (!msg || msg.type !== "history" || !Array.isArray(msg.items)) return null;
  const items = msg.items.filter(isHistory);
  return {
    type: "history",
    items,
    total: typeof msg.total === "number" ? msg.total : items.length,
  };
}

/** What a reader shows: the latest node per id (newest first) and the log (oldest first). */
export type ProgressView = { rows: ProgressEntry[]; log: ProgressEvent[] };

/** Apply a hub message to a reader's view. */
export function applyProgressMessage(view: ProgressView, msg: ProgressMessage): ProgressView {
  if (msg.type === "snapshot")
    return { rows: [...msg.entries].sort((a, b) => b.at - a.at), log: msg.log };
  const { type: _type, note, ...rest } = msg;
  const prev = view.rows.find((r) => r.id === msg.id);
  const notes = [...(prev?.notes ?? [])];
  if (note) notes.push({ at: msg.at, by: msg.by, text: note });
  const entry: ProgressEntry = {
    ...rest,
    ...(notes.length ? { notes: notes.slice(-PROGRESS_NOTES_MAX) } : {}),
  };
  return {
    rows: [entry, ...view.rows.filter((r) => r.id !== msg.id)].sort((a, b) => b.at - a.at),
    log: [...view.log, msg].slice(-PROGRESS_LOG_MAX),
  };
}

/** Open work in a subtree: all open nodes that are not groups or people, and the feedback among them. */
export type ProgressCounts = { tasks: number; feedback: number };
export type ProgressNode = ProgressEntry & {
  children: ProgressNode[];
  counts: ProgressCounts;
  /** This node waits on the owner (see waitsOnOwner). */
  waitingOwner: boolean;
  /** Nodes waiting on the owner in this subtree, this one included. */
  waitingOwnerCount: number;
};

const isOpen = (e: ProgressEntry) => e.status !== "done";
const isWork = (e: ProgressEntry) => isOpen(e) && e.kind !== "group" && e.kind !== "person";

/**
 * Does this node wait on the owner? An open decision or approval, or any
 * open node marked waiting-owner or with something in `needs` — or one an
 * open to-do under OWNER_NODE refs (`todoRefs`).
 */
export const waitsOnOwner = (e: ProgressEntry, todoRefs: ReadonlySet<string> = new Set()) =>
  isOpen(e) &&
  (e.kind === "decision" ||
    e.kind === "approval" ||
    e.status === "waiting-owner" ||
    (!!e.needs?.trim() && (!e.who || e.who === OWNER_NAME)) ||
    blockedOn(e) === OWNER_NAME ||
    todoRefs.has(e.id));

/**
 * Blocked on someone who can act now (docs/state-tree.md, "Blocked and
 * paused"): status blocked with `who` — "owner" or a lane. Its name, else
 * undefined (blocked with no who is the old, plain blocked: no nudges).
 */
export const blockedOn = (e: Pick<ProgressEntry, "status" | "who">): string | undefined =>
  e.status === "blocked" && e.who?.trim() ? e.who.trim() : undefined;

/** Paused: status waiting, on an outside event. No nudges, no overrun. */
export const isPaused = (e: Pick<ProgressEntry, "status">) => e.status === "waiting";

/** What a blocked node's nudges are about: who and what. A change starts them over. */
export const nudgeKey = (
  e: Pick<ProgressEntry, "status" | "who" | "needs">,
): string | undefined => {
  const who = blockedOn(e);
  return who === undefined ? undefined : `${who}|${e.needs?.trim() ?? ""}`;
};

/** The ids open owner to-dos point at. */
export function openTodoRefs(entries: Iterable<ProgressEntry>): Set<string> {
  const refs = new Set<string>();
  for (const e of entries) if (isOwnerTodo(e.id) && isOpen(e) && e.ref) refs.add(e.ref);
  return refs;
}

/** Siblings: waiting on the owner first, then those with a waiting descendant, then newest first. */
const rank = (n: ProgressNode) => (n.waitingOwner ? 2 : n.waitingOwnerCount > 0 ? 1 : 0);

/**
 * Fold nodes or events (in the order they happened) into the tree: the latest
 * per id, children grouped under their parent, and per node its open counts
 * and owner-waiting count over its subtree. Siblings are ordered by rank,
 * then newest first. A node whose parent is unknown — or whose parent chain
 * loops back to it — is a root.
 */
export function foldProgress(events: Iterable<ProgressEntry | ProgressEvent>): ProgressNode[] {
  const nodes = new Map<string, ProgressNode>();
  for (const e of events) {
    const { type: _type, note: _note, ...entry } = e as ProgressEvent;
    nodes.set(entry.id, {
      ...(entry as ProgressEntry),
      children: [],
      counts: { tasks: 0, feedback: 0 },
      waitingOwner: false,
      waitingOwnerCount: 0,
    });
  }
  const refs = openTodoRefs(nodes.values());
  const loops = (id: string) => {
    const seen = new Set([id]);
    for (let p = nodes.get(id)?.parent; p !== undefined; p = nodes.get(p)?.parent) {
      if (seen.has(p)) return true;
      if (!nodes.has(p)) return false;
      seen.add(p);
    }
    return false;
  };
  const roots: ProgressNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent === undefined ? undefined : nodes.get(node.parent);
    if (parent && !loops(node.id)) parent.children.push(node);
    else roots.push(node);
  }
  const finish = (list: ProgressNode[]) => {
    const sum = { tasks: 0, feedback: 0, waiting: 0 };
    for (const n of list) {
      const below = finish(n.children);
      const self = isWork(n) ? 1 : 0;
      n.counts = {
        tasks: below.tasks + self,
        feedback: below.feedback + (self && n.kind === "feedback" ? 1 : 0),
      };
      n.waitingOwner = waitsOnOwner(n, refs);
      n.waitingOwnerCount = below.waiting + (n.waitingOwner ? 1 : 0);
      sum.tasks += n.counts.tasks;
      sum.feedback += n.counts.feedback;
      sum.waiting += n.waitingOwnerCount;
    }
    list.sort((a, b) => rank(b) - rank(a) || b.at - a.at);
    return sum;
  };
  finish(roots);
  return roots;
}

/** Keep only nodes waiting on the owner and their ancestors (the "Needs me" filter). */
export function filterWaiting(tree: ProgressNode[]): ProgressNode[] {
  return tree
    .filter((n) => n.waitingOwnerCount > 0)
    .map((n) => ({ ...n, children: filterWaiting(n.children) }));
}

/** The owner's to-do list: the open nodes of his subtree, oldest first. */
export function progressTodo(entries: Iterable<ProgressEntry>): ProgressEntry[] {
  return [...entries]
    .filter((e) => isOwnerTodo(e.id) && isOpen(e))
    .sort((a, b) => a.created - b.created);
}

/** Which badge a node waiting on the owner wears. */
export function waitBadge(e: ProgressEntry): "Decision" | "Approve" | "Needs you" {
  return e.kind === "decision" ? "Decision" : e.kind === "approval" ? "Approve" : "Needs you";
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function progressAgo(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** The longest estimate the hub takes: a month. */
export const PROGRESS_ETA_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * An agent's `--eta`: a duration from now ("15m", "1h30m", "90s", "2d"), a
 * range of two ("12m-63m": `min` its P5, `in` its P95) or
 * an ISO time with its zone ("2026-11-07T20:30+09:00"). Anything else (free
 * text, "after CI") is null: shown as written, with no bar and no ping.
 */
export function parseEta(s: string): { in: number; min?: number } | { at: number } | null {
  const t = s.trim();
  // A range "12m-63m" (or "12m–63m"): P5 to P95 of what it may take. The end
  // is the estimate (etaAt: the bar, the ping, overdue); the start its P5.
  const range = /^(.+?)\s*(?:-|–|—|\.\.)\s*(.+)$/.exec(t);
  if (range && !/^\d{4}-/.test(t)) {
    const lo = parseEta(range[1]!);
    const hi = parseEta(range[2]!);
    if (!lo || !hi || !("in" in lo) || !("in" in hi) || lo.min !== undefined) return null;
    if (lo.in > hi.in) return null;
    return lo.in === hi.in ? { in: hi.in } : { in: hi.in, min: lo.in };
  }
  const parts =
    /^(?:(\d+(?:\.\d+)?)\s*d)?\s*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i.exec(
      t,
    );
  if (t && parts && parts.slice(1).some((x) => x !== undefined)) {
    const [d, h, m, sec] = parts.slice(1).map((x) => Number(x ?? 0));
    const ms = Math.round(((d! * 24 + h!) * 60 + m!) * 60_000 + sec! * 1000);
    return ms > 0 && ms <= PROGRESS_ETA_MAX_MS ? { in: ms } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const at = Date.parse(t);
    return Number.isFinite(at) ? { at } : null;
  }
  return null;
}

/** "8h", "30m", "2d", "90s" → milliseconds; an Error otherwise. */
export function parseTtl(s: string): number | Error {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(s.trim());
  if (!m) return new Error(`ttl must look like 30m, 8h or 2d, not ${s}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * unit);
}
