// `lianki progress`: report your work to the user's live task list (the state
// tree, docs/state-tree.md "Live progress"), with an API token holding the
// `progress` permission. The same verbs and flags as the repo's
// scripts/dev/progress.ts, mapped here from parsed flags to the hub's request:
// the hub (lianki-push ProgressHub) validates every field and fills the agent
// in from the token's name. Runtime-neutral (no node: imports): the MCP
// progress tools (mcp-tools.mjs) build their requests with the same functions.

import { CliError, EXIT } from "./api.mjs";

export const PROGRESS_PATH = "/api/version/progress";
/** The hub's statuses (lib/progress.ts PROGRESS_STATUSES); the hub is the judge, this is the help text. */
export const PROGRESS_STATUSES = ["doing", "blocked", "waiting", "waiting-owner", "review", "done"];
export const PROGRESS_KINDS = ["task", "decision", "approval", "feedback", "person", "group"];
/** A receipt code on an "ETA reached" line (lib/progress.ts RECEIPT_RE). */
export const RECEIPT_RE = /^[a-z0-9]{6}$/;
/** A change id (lib/progress.ts CHANGE_ID_RE). */
export const CHANGE_ID_RE = /^[A-Za-z0-9._:-]{1,40}$/;
/** `stats` and `history` without --since: how far back. */
export const STATS_SINCE_DEFAULT = "7d";
export const HISTORY_LIMIT_DEFAULT = 2000;

const usage = (msg, hint) => new CliError("usage", EXIT.usage, msg, hint);

/** A duration like 30m, 1h30m, 2d, 7d → ms; null when it is not one. */
export function parseTtl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
  let ms = 0;
  let used = 0;
  for (const m of raw.trim().matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    ms += n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
    used += m[0].length;
  }
  if (!used || used !== raw.trim().replace(/\s+/g, "").length || !(ms > 0)) return null;
  return ms;
}

/** `--pr 299` or `--pr 703,707` → {pr} or {prs}; an Error names what is wrong. */
export function parsePr(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  const list = String(raw)
    .split(",")
    .map((v) => Number(v.trim().replace(/^#/, "")));
  if (!list.length || !list.every((n) => Number.isInteger(n) && n > 0))
    throw usage("--pr must be a number or numbers separated by commas", "--pr 299   or   --pr 703,707");
  return list.length === 1 ? { pr: list[0] } : { prs: list };
}

const str = (v) => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * The flags of one report (`lianki progress …`, or one item of `batch`) →
 * the body POST /api/version/progress takes. Only the mapping is here: the
 * hub checks titles, scopes, ETAs and the overrun rule and says why not.
 */
export function reportBody(a = {}) {
  const b = {};
  const path = str(a.path);
  const id = str(a.id);
  if (path && id && path !== id) throw usage("--path and --id differ; give one");
  if (path ?? id) b.id = path ?? id;
  if (str(a.parent)) b.parent = a.parent;
  const task = str(a.task);
  if (!task)
    throw usage(
      'progress needs --task "<name>: <description>"',
      'lianki progress --path /words/swipe --task "Swipe fix: the card snaps back" --status doing --eta 30m',
    );
  b.task = task;
  const status = a.done ? "done" : str(a.status);
  if (!status)
    throw usage(`progress needs --status <${PROGRESS_STATUSES.join("|")}> (or --done)`);
  if (!PROGRESS_STATUSES.includes(status))
    throw usage(`--status must be one of ${PROGRESS_STATUSES.join(", ")}`);
  b.status = status;
  if (status === "blocked" && !str(a.who))
    throw usage(
      '--status blocked names who can act now: --who owner|<name> --needs "what they must do"; paused on an outside event is --status waiting',
    );
  if (a.human) {
    if (!str(a.agent)) throw usage("--human needs --agent <name>: the person's name");
    b.assignee = { type: "human", name: a.agent };
  } else if (str(a.agent)) b.agent = a.agent;
  if (a.pct !== undefined && a.pct !== null && a.pct !== "") {
    const n = Number(String(a.pct).replace(/%$/, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw usage("--pct must be 0–100");
    b.pct = n;
  }
  for (const k of ["eta", "late", "note", "needs", "who", "ref", "action", "link", "kind"])
    if (str(a[k])) b[k] = a[k];
  if (b.kind && !PROGRESS_KINDS.includes(b.kind))
    throw usage(`--kind must be one of ${PROGRESS_KINDS.join(", ")}`);
  if (a.confirm) b.confirm = true;
  Object.assign(b, parsePr(a.pr));
  if (a.rev !== undefined && a.rev !== null && a.rev !== "") {
    const n = Number(a.rev);
    if (!Number.isInteger(n) || n < 0) throw usage("--rev must be a whole number");
    b.rev = n;
  }
  const changeId = str(a.changeId ?? a["change-id"]);
  if (changeId) {
    if (!CHANGE_ID_RE.test(changeId)) throw usage("--change-id must be 1–40 of A-Z a-z 0-9 . _ : -");
    b.changeId = changeId;
  }
  if (str(a.ended)) {
    const at = Date.parse(a.ended);
    if (!Number.isFinite(at)) throw usage("--ended must be an ISO time");
    b.endedAt = at;
  }
  if (str(a.verified) && a.unverified) throw usage("--verified and --unverified: one or the other");
  if (str(a.verified)) b.verified = a.verified;
  else if (a.unverified) b.unverified = true;
  // A plain --done is "done, not confirmed": the hub adds a "verify: …" child.
  // Evidence makes it verified: --verified "<what shows it>" (a merged PR, a test, a screenshot link).
  else if (status === "done") b.unverified = true;
  if (b.late && !b.eta) throw usage('--late "<why>" goes with a new --eta');
  if (b.status !== "done" && (b.verified || b.unverified))
    throw usage("--verified / --unverified go with --done");
  return b;
}

/**
 * `batch`'s list: JSON, each item an object keyed by the report flags
 * ({"path": "/x", "task": "A: …", "status": "doing", "eta": "20m"}); true for
 * a switch. → the body of POST /api/version/progress/batch.
 */
export function batchBody(text, changeId) {
  let items;
  try {
    items = typeof text === "string" ? JSON.parse(text) : text;
  } catch (e) {
    throw usage(`batch: ${e?.message ?? e}`);
  }
  if (!Array.isArray(items) || !items.length) throw usage("batch needs a JSON list of reports");
  const reports = items.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw usage(`batch item ${i}: not an object`);
    if ("token" in item || "changeId" in item || "change-id" in item)
      throw usage(`batch item ${i}: the change id goes on the batch (--change-id), not an item`);
    try {
      return reportBody(item);
    } catch (e) {
      throw e instanceof CliError ? usage(`batch item ${i}: ${e.message}`, e.hint) : e;
    }
  });
  const body = { reports };
  const cid = str(changeId);
  if (cid) {
    if (!CHANGE_ID_RE.test(cid)) throw usage("--change-id must be 1–40 of A-Z a-z 0-9 . _ : -");
    body.changeId = cid;
  }
  return body;
}

/** `ack <code>` → the body of POST /api/version/progress/ack. */
export function ackBody(code) {
  const c = String(code ?? "").trim().toLowerCase();
  if (!RECEIPT_RE.test(c)) throw usage("ack needs the receipt code from the ETA line: lianki progress ack k3x9qa");
  return { code: c };
}

/** `--since 7d` → ms, with the default; a usage error when it is not a duration. */
export function sinceMs(raw, fallback = STATS_SINCE_DEFAULT) {
  const ms = parseTtl(raw === undefined || raw === null || raw === "" ? fallback : String(raw));
  if (ms === null) throw usage("--since is a duration like 7d, 30d or 12h");
  return ms;
}

/** "2026-11-07 20:30 JST": when an estimate runs out, as the owner reads times. */
export const etaJst = (at) =>
  `${new Date(at + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} JST`;

/** The hub's answer to a report, as one line for a terminal. */
export function entryLine(res) {
  const e = res?.entry ?? {};
  const eta = e.etaAt
    ? `, ETA ${e.etaMinAt ? `${etaJst(e.etaMinAt).slice(11, 16)}–` : ""}${etaJst(e.etaAt)}`
    : "";
  const kind = e.doneKind ? ` ${e.doneKind}${e.evidence ? `: ${e.evidence}` : ""}` : "";
  const lines = [`progress: ${e.id} ${e.status}${kind} (rev ${e.rev}${eta}, ${res?.readers ?? 0} watching)`];
  if (e.doneKind === "unverified")
    lines.push('progress: not verified yet — when it is confirmed: --done --verified "<evidence>"');
  if (res?.told === true) lines.push("progress: the owner was told the reason and the new time");
  else if (res?.told === false)
    lines.push("progress: warning: the reason could not be posted to the owner; say it in the chat");
  return lines.join("\n");
}

const mins = (ms) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

/**
 * `stats`: the hub's done log (GET /stats → {done: [...]}) folded per agent:
 * done count, how many had an estimate, the median actual/estimate ratio,
 * then one line per task. `agent` keeps one agent; `since` (ms) the window.
 */
export function statsOf(done, { agent, since, now = Date.now() } = {}) {
  const rows = (Array.isArray(done) ? done : []).filter(
    (d) =>
      d && typeof d === "object" &&
      (!agent || d.agent === agent) &&
      (since === undefined || Number(d.endedAt ?? d.at ?? 0) >= now - since),
  );
  const by = new Map();
  for (const d of rows) {
    const a = by.get(d.agent) ?? { agent: d.agent, done: 0, estimated: 0, ratios: [], tasks: [] };
    const actualMs = Number(d.actualMs ?? (d.endedAt && d.startedAt ? d.endedAt - d.startedAt : 0)) || 0;
    const estimateMs = Number(d.estimateMs) || 0;
    a.done++;
    if (estimateMs > 0) {
      a.estimated++;
      a.ratios.push(actualMs / estimateMs);
    }
    a.tasks.push({ id: d.id, title: d.title ?? d.task ?? "", actualMs, estimateMs, revisions: d.revisions ?? 0 });
    by.set(d.agent, a);
  }
  return [...by.values()].map((a) => {
    const r = [...a.ratios].sort((x, y) => x - y);
    const medianRatio = r.length ? (r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2) : undefined;
    return { agent: a.agent, done: a.done, estimated: a.estimated, medianRatio, tasks: a.tasks };
  });
}

export function formatStats(stats) {
  if (!stats.length) return "progress: no done tasks in that window";
  return stats
    .map((a) => {
      const ratio = a.medianRatio === undefined ? "no estimates" : `median ×${a.medianRatio.toFixed(2)}`;
      const rows = a.tasks.map((d) => {
        const est = d.estimateMs ? mins(d.estimateMs) : "—";
        const x = d.estimateMs ? ` ×${(d.actualMs / d.estimateMs).toFixed(2)}` : "";
        const rev = d.revisions ? `, ${d.revisions} revised` : "";
        return `  ${d.id}  est ${est} → actual ${mins(d.actualMs)}${x}${rev}  ${d.title}`;
      });
      return [`${a.agent}: ${a.done} done, ${a.estimated} estimated, ${ratio}`, ...rows].join("\n");
    })
    .join("\n");
}

/** `history`: one line per done node (JST end time, id, PRs, title), newest first. */
export function formatHistory(items, { agent, since, now = Date.now() } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(
    (h) => (!agent || h.agent === agent) && (since === undefined || Number(h.endedAt) >= now - since),
  );
  if (!rows.length) return "progress: no done nodes in the history for that filter";
  return rows
    .map((h) => {
      const prs = h.prs?.length ? `  ${h.prs.map((n) => `#${n}`).join(" ")}` : "";
      const kind = h.doneKind ? `  [${h.doneKind}${h.evidence ? `: ${h.evidence}` : ""}]` : "";
      return `${etaJst(h.endedAt).slice(0, 16)} JST  ${h.id}${prs}  ${h.title}  (${h.agent})${kind}`;
    })
    .join("\n");
}

/** One batch result as lines: each node's id and status, then the change id. */
export function batchLines(res) {
  const results = Array.isArray(res?.results) ? res.results : [];
  const lines = results.map((r) => {
    const e = r?.entry;
    return e
      ? `progress: ${e.id} ${e.status}${e.etaAt ? `, ETA ${etaJst(e.etaAt)}` : ""}`
      : `progress: ${r?.status ?? "?"} ${String(r?.error ?? "failed")}`;
  });
  lines.push(`progress: change ${String(res?.changeId)} (${results.length} nodes)`);
  return lines.join("\n");
}
