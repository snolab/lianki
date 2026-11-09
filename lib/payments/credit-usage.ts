/**
 * The credits usage view (/membership/credits, docs/payments.md "Credits
 * usage"): every line of the user's own wallet ledger, with the balance after
 * it, what it was for, per-feature totals for the month and a CSV export.
 *
 * - A metered call's hold (`ai` row, −held) and its settle refund (`refund`
 *   row, same refId) read as ONE entry: held, actual (held − refunded),
 *   refunded. A hold with no refund yet is pending.
 * - The balance after each entry is the running sum of the ledger in the
 *   order it was written (`createdAt`, then rowid), computed here, never
 *   trusted from the client. A merged entry shows the balance after its last
 *   part (the refund once settled).
 * - The feature of an `ai` row is its ledger `note` (the metered call's
 *   feature id); none = a Learning Partner reply (the older path). Other
 *   reasons are their own feature. No private content is ever in a line: a
 *   feature id and a link to its page, nothing the user wrote.
 * - Dates (filters, the month) are in the viewer's time zone, validated.
 *
 * The wallet card's short history (`ledger()` in credits-store.ts) is separate
 * and unchanged.
 */
import type { D1Like } from "@/lib/d1/types";
import type { CreditReason } from "./credits";

/** Feature groups shown to the user (labels: credits-usage.content.ts `groups`). */
export type UsageGroup =
  | "partner"
  | "gloss"
  | "polish"
  | "translate"
  | "selfIntro"
  | "voice"
  | "stt"
  | "sentences"
  | "roadmap"
  | "ai"
  | Exclude<CreditReason, "ai">;

/** Each metered feature id: its group and the page it was used on (none: no page to open). */
export const FEATURES: Readonly<Record<string, { group: UsageGroup; href: string | null }>> = {
  "partner.reply": { group: "partner", href: "/chat/history" },
  "read.gloss": { group: "gloss", href: "/reader" },
  "read.polish": { group: "polish", href: "/reader" },
  "read.live-polish": { group: "polish", href: "/reader" },
  "read.translate": { group: "translate", href: "/reader" },
  "vibe.translate": { group: "translate", href: "/vibe" },
  "self-intro.followup": { group: "selfIntro", href: "/self-intro" },
  "self-intro.import": { group: "selfIntro", href: "/self-intro" },
  "self-intro.translate": { group: "translate", href: "/self-intro" },
  "self-intro.tts": { group: "voice", href: "/self-intro" },
  "words.tts": { group: "voice", href: "/words" },
  "speech.stt": { group: "stt", href: null },
  "ai-sentences": { group: "sentences", href: "/lab/ai-vocab" },
  "polyglot.translate": { group: "translate", href: "/lab/polyglot" },
  "polyglot.tts": { group: "voice", href: "/lab/polyglot" },
  "roadmap.generate": { group: "roadmap", href: "/roadmap" },
  "blog.translate": { group: "translate", href: "/blog" },
  tts: { group: "voice", href: null },
};

/** Every group, in the order the filter lists them. */
export const GROUPS: readonly UsageGroup[] = [
  "partner",
  "gloss",
  "polish",
  "translate",
  "selfIntro",
  "voice",
  "stt",
  "sentences",
  "roadmap",
  "ai",
  "topup",
  "pass",
  "refund",
  "gift",
  "sponsor",
  "adjust",
];

export const isGroup = (v: unknown): v is UsageGroup =>
  typeof v === "string" && (GROUPS as readonly string[]).includes(v);

/** A raw ledger row, in written order. */
export interface UsageRow {
  id: string;
  amount: number;
  reason: CreditReason;
  refId: string;
  passId: string | null;
  note: string | null;
  createdAt: string;
}

/** One line of the view. */
export interface UsageEntry {
  id: string;
  /** When it happened (the hold's time for a metered call), ISO UTC. */
  at: string;
  reason: CreditReason;
  /** The feature id (`ai` rows) or the reason. */
  feature: string;
  group: UsageGroup;
  /** Net change to the balance (held − refunded for a metered call). */
  amount: number;
  balanceAfter: number;
  passId: string | null;
  /** The page it was used on, when there is one. */
  href: string | null;
  /** A metered call: what was held, what it really cost, what came back. */
  hold?: { held: number; actual: number; refunded: number; pending: boolean };
}

/** The feature id of a row: an `ai` row's note, else a Learning Partner reply; other reasons are themselves. */
export function featureOf(r: Pick<UsageRow, "reason" | "note">): string {
  if (r.reason !== "ai") return r.reason;
  return r.note?.trim() || "partner.reply";
}

export function groupOf(feature: string): UsageGroup {
  if (FEATURES[feature]) return FEATURES[feature].group;
  if (isGroup(feature) && !(feature in FEATURES)) return feature;
  return "ai";
}

const hrefOf = (feature: string, reason: CreditReason) =>
  FEATURES[feature]?.href ?? (reason === "pass" ? "/membership" : null);

/**
 * Rows (in written order) → entries, oldest first: holds and their refunds
 * merged, the running balance after each. `start` is the balance before the
 * first row (0 for a whole ledger; see usagePage for a capped read).
 */
export function buildEntries(rows: UsageRow[], start = 0): UsageEntry[] {
  const holds = new Map<string, UsageEntry>();
  const out: UsageEntry[] = [];
  let balance = start;
  for (const r of rows) {
    balance += r.amount;
    if (r.reason === "refund" && r.refId.startsWith("ai:")) {
      const e = holds.get(r.refId);
      if (e?.hold) {
        e.hold.refunded += r.amount;
        e.hold.actual = e.hold.held - e.hold.refunded;
        e.hold.pending = false;
        e.amount += r.amount;
        e.balanceAfter = balance;
        continue;
      }
    }
    const feature = featureOf(r);
    const e: UsageEntry = {
      id: r.id,
      at: r.createdAt,
      reason: r.reason,
      feature,
      group: groupOf(feature),
      amount: r.amount,
      balanceAfter: balance,
      passId: r.passId,
      href: hrefOf(feature, r.reason),
    };
    if (r.reason === "ai" && r.amount < 0) {
      e.hold = { held: -r.amount, actual: -r.amount, refunded: 0, pending: true };
      holds.set(r.refId, e);
    }
    out.push(e);
  }
  return out;
}

/** A valid IANA zone, else UTC. */
export function safeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const parts = (iso: string | number | Date, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return p as Record<"year" | "month" | "day" | "hour" | "minute", string>;
};

/** YYYY-MM-DD of an instant in a zone. */
export function localDay(iso: string | number | Date, tz: string): string {
  const p = parts(iso, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** YYYY-MM-DD HH:mm of an instant in a zone (the CSV's local time). */
export function localTime(iso: string | number | Date, tz: string): string {
  const p = parts(iso, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A YYYY-MM-DD filter value, else null. */
export const dayParam = (v: unknown): string | null =>
  typeof v === "string" && DAY.test(v) ? v : null;

export interface UsageFilter {
  group?: UsageGroup | null;
  /** Inclusive local days (YYYY-MM-DD) in `tz`. */
  from?: string | null;
  to?: string | null;
  tz: string;
}

export function filterEntries(entries: UsageEntry[], f: UsageFilter): UsageEntry[] {
  return entries.filter((e) => {
    if (f.group && e.group !== f.group) return false;
    if (f.from || f.to) {
      const d = localDay(e.at, f.tz);
      if (f.from && d < f.from) return false;
      if (f.to && d > f.to) return false;
    }
    return true;
  });
}

export interface GroupTotal {
  group: UsageGroup;
  /** Credits taken (a positive number). */
  spent: number;
  /** Credits added. */
  added: number;
  count: number;
}

/** Per-group totals for the month `now` falls in, in `tz`; biggest spend first. */
export function monthTotals(entries: UsageEntry[], tz: string, now = new Date()): GroupTotal[] {
  const month = localDay(now, tz).slice(0, 7);
  const by = new Map<UsageGroup, GroupTotal>();
  for (const e of entries) {
    if (localDay(e.at, tz).slice(0, 7) !== month) continue;
    const t = by.get(e.group) ?? { group: e.group, spent: 0, added: 0, count: 0 };
    if (e.amount < 0) t.spent += -e.amount;
    else t.added += e.amount;
    t.count++;
    by.set(e.group, t);
  }
  return [...by.values()].sort((a, b) => b.spent - a.spent || b.added - a.added);
}

const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  // A leading = + - @ would be read as a formula by spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const CSV_HEADER = [
  "time_utc",
  "time_local",
  "feature",
  "reason",
  "amount",
  "held",
  "actual",
  "refunded",
  "pending",
  "balance_after",
  "pass",
];

/** The entries as CSV (oldest first), times in UTC and in `tz`. */
export function toCsv(entries: UsageEntry[], tz: string): string {
  const lines = [CSV_HEADER.join(",")];
  for (const e of entries)
    lines.push(
      [
        e.at,
        localTime(e.at, tz),
        e.feature,
        e.reason,
        e.amount,
        e.hold?.held,
        e.hold?.actual,
        e.hold?.refunded,
        e.hold ? (e.hold.pending ? "yes" : "no") : "",
        e.balanceAfter,
        e.passId,
      ]
        .map(cell)
        .join(","),
    );
  return `${lines.join("\r\n")}\r\n`;
}

/** Rows read at most (a wallet with more shows its newest this many). */
export const MAX_ROWS = 20_000;

/** The user's own ledger rows, in written order (only `userId`'s, ever). */
export async function usageRows(d1: D1Like, userId: string, max = MAX_ROWS): Promise<UsageRow[]> {
  const { results } = await d1
    .prepare(
      `SELECT id, amount, reason, refId, passId, note, createdAt FROM (
         SELECT id, amount, reason, refId, passId, note, createdAt, rowid AS rid
         FROM credit_ledger WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
       ) ORDER BY createdAt, rid`,
    )
    .bind(userId, max)
    .all<UsageRow>();
  return results.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export interface UsagePage {
  balance: number;
  /** Newest first, after the filter. */
  entries: UsageEntry[];
  total: number;
  month: GroupTotal[];
  /** The groups this wallet has entries in (the filter's options). */
  groups: UsageGroup[];
}

/**
 * One page of the view for a request's query (`tz`, `group`, `from`, `to`,
 * `offset`, `limit`; `all` ignores the last two: the CSV). `balance` is the cached wallet balance: the running
 * balance starts where it puts it, so a read capped at MAX_ROWS still ends on
 * the real balance.
 */
export function usagePage(
  rows: UsageRow[],
  balance: number,
  q: URLSearchParams,
  now = new Date(),
  opts: { all?: boolean } = {},
): UsagePage & { tz: string } {
  const tz = safeZone(q.get("tz"));
  const sum = rows.reduce((n, r) => n + r.amount, 0);
  const all = buildEntries(rows, balance - sum);
  const group = q.get("group");
  const filtered = filterEntries(all, {
    group: isGroup(group) ? group : null,
    from: dayParam(q.get("from")),
    to: dayParam(q.get("to")),
    tz,
  }).reverse();
  const offset = Math.max(0, Math.floor(Number(q.get("offset")) || 0));
  const limit = Math.min(500, Math.max(1, Math.floor(Number(q.get("limit")) || 100)));
  const present = new Set(all.map((e) => e.group));
  return {
    tz,
    balance,
    entries: opts.all ? filtered : filtered.slice(offset, offset + limit),
    total: filtered.length,
    month: monthTotals(all, tz, now),
    groups: GROUPS.filter((g) => present.has(g)),
  };
}
