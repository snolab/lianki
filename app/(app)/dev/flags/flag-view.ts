/**
 * What /dev/flags shows: sections, search, filters, the shipped view and where
 * a link lands. Pure, so it is tested without a browser. It only decides what
 * is shown: nothing here changes a flag. docs/feature-flags.md, "The page".
 */
import {
  FLAG_KEYS,
  FLAG_OLD_KEYS,
  FLAGS,
  isFlagKey,
  type FlagDef,
  type FlagKey,
} from "@/lib/flags";
import type { FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";
import { flagKeyFromHash } from "./flag-anchor";

export const OTHER_GROUP = "other";
export const SHIPPED_GROUP = "shipped";

/** A group's words; a group not listed here shows its own id, so a new prefix needs nothing. */
const GROUP_LABELS: Record<string, string> = {
  payments: "收款",
  read: "阅读",
  stt: "语音",
  box: "开发盒",
  ai: "AI",
  [OTHER_GROUP]: "其他",
  [SHIPPED_GROUP]: "已全面打开",
};

export const groupLabel = (id: string) => GROUP_LABELS[id] ?? id;

/** A section's DOM id. Prefixed: a group may share its name with a flag (`levels`). */
export const groupDomId = (id: string) => `flag-group-${id}`;

/** The flag's own `group`, else its key's prefix. */
export function rawFlagGroup(key: string, def?: Pick<FlagDef, "group">): string {
  return def?.group ?? key.split(".")[0]!;
}

/**
 * Every key's section. A group of one is no section: it goes to 其他, so a new
 * prefix does not add a heading until it has a second flag. Counted over the
 * whole registry, so filtering never moves a flag.
 */
export function assignGroups(
  keys: readonly string[] = FLAG_KEYS,
  defOf: (key: string) => Pick<FlagDef, "group"> | undefined = (k) =>
    FLAGS[k as FlagKey] as FlagDef | undefined,
): Map<string, string> {
  const raw = new Map(keys.map((k) => [k, rawFlagGroup(k, defOf(k))]));
  const size = new Map<string, number>();
  for (const g of raw.values()) size.set(g, (size.get(g) ?? 0) + 1);
  return new Map(keys.map((k) => [k, size.get(raw.get(k)!)! > 1 ? raw.get(k)! : OTHER_GROUP]));
}

const REGISTRY_GROUPS = assignGroups();

/**
 * On for everyone now: switched on, reaching every user, needing nothing that is
 * missing. Not a payment flag: those are standing kill switches, not rollouts.
 * Without `audience` a flag reaches every user once on (lib/flags.ts).
 */
export function isShipped(
  row: Pick<FlagRow, "key" | "enabled">,
  failed?: PrereqFailure[],
): boolean {
  const def = FLAGS[row.key] as FlagDef;
  return row.enabled && !def.money && !def.audience && !failed?.length;
}

/** All terms in the key, its old key or its description, ignoring case and width. */
export function matchesSearch(row: Pick<FlagRow, "key" | "description">, q: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase();
  const old = (FLAG_OLD_KEYS as Partial<Record<FlagKey, string>>)[row.key] ?? "";
  const text = norm(`${row.key} ${old} ${row.description}`);
  return norm(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
}

export type StateFilter = "all" | "on" | "off";

export type FlagFilters = {
  q: string;
  /** "off": a flag off now (most are off by default; a default-on one only when switched off). */
  state: StateFilter;
  recent: boolean;
};

export const NO_FILTERS: FlagFilters = { q: "", state: "all", recent: false };

export const filtersActive = (f: FlagFilters) => f.q.trim() !== "" || f.state !== "all" || f.recent;

/** "Recently changed" reaches this far back. */
export const RECENT_DAYS = 7;

/** Changed in the last RECENT_DAYS, from the row's `updated_at` (a renamed flag's old row counts). */
export function isRecent(row: Pick<FlagRow, "updatedAt">, now: number): boolean {
  if (!row.updatedAt) return false;
  const at = new Date(row.updatedAt).getTime();
  return now - at < RECENT_DAYS * 86_400_000;
}

export function passesFilters(row: FlagRow, f: FlagFilters, now: number): boolean {
  if (f.state === "on" && !row.enabled) return false;
  if (f.state === "off" && row.enabled) return false;
  if (f.recent && !isRecent(row, now)) return false;
  return matchesSearch(row, f.q);
}

export type FlagGroupView = {
  id: string;
  label: string;
  /** What is shown now. */
  rows: FlagRow[];
  /** The whole section, whatever the filters: its count of on / all. */
  on: number;
  total: number;
};

export type FlagViewInput = FlagFilters & {
  now: number;
  prereqs?: Partial<Record<FlagKey, PrereqFailure[]>>;
  /** Reached by a link: no search or filter hides it. */
  pinned?: FlagKey | null;
  /**
   * Toggled just now, and whether it counted as shipped then. It stays where it
   * was and stays shown, so the switch does not run away from the finger.
   */
  held?: ReadonlyMap<FlagKey, boolean>;
};

/** The section a row is in right now. */
export function groupOfRow(
  row: Pick<FlagRow, "key" | "enabled">,
  input: Pick<FlagViewInput, "prereqs" | "held">,
): string {
  const shipped = input.held?.get(row.key) ?? isShipped(row, input.prereqs?.[row.key]);
  return shipped ? SHIPPED_GROUP : (REGISTRY_GROUPS.get(row.key) ?? OTHER_GROUP);
}

/**
 * The sections in registry order, 其他 then the shipped view last. A section with
 * nothing to show is left out.
 */
export function buildFlagView(rows: FlagRow[], input: FlagViewInput): FlagGroupView[] {
  const groups = new Map<string, FlagGroupView>();
  for (const row of rows) {
    const id = groupOfRow(row, input);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, label: groupLabel(id), rows: [], on: 0, total: 0 }));
    g.total++;
    if (row.enabled) g.on++;
    if (
      row.key === input.pinned ||
      input.held?.has(row.key) ||
      passesFilters(row, input, input.now)
    )
      g.rows.push(row);
  }
  const rank = (id: string) => (id === SHIPPED_GROUP ? 2 : id === OTHER_GROUP ? 1 : 0);
  return [...groups.values()]
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => rank(a.id) - rank(b.id));
}

/** Open sections, per device: only what the owner changed. Shipped starts folded. */
export function isGroupOpen(open: Record<string, boolean>, id: string): boolean {
  return open[id] ?? id !== SHIPPED_GROUP;
}

/**
 * The flag a hash names: the key itself or, for an old link, the key it was
 * renamed from (FLAG_OLD_KEYS). Null when it names no flag.
 */
export function resolveFlagAnchor(hash: string): FlagKey | null {
  const key = flagKeyFromHash(hash);
  if (key === null) return null;
  if (isFlagKey(key)) return key;
  const renamed = Object.entries(FLAG_OLD_KEYS).find(([, old]) => old === key);
  return renamed ? (renamed[0] as FlagKey) : null;
}
