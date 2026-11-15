/**
 * Li's roster in the owner's thread (owner, 2026-11-15: "它应该能够看到所有在这里的人，
 * 以及能够知道各自的职责，所以我让它报数的时候就不要再说它做不到什么什么了"):
 * who is present (the hub's presence list, presence.ts), each one's mode and
 * mute, and its role (voices.ts LANES `role`, config `chat.lanes` rows' `role`).
 *
 * The hub turns its presence list into entries (rosterOf) and sends them with
 * the owner-thread request (PartnerRequest.roster); the main Worker bounds
 * them (parseRoster) and puts rosterSection into Li's system prompt. The hub's
 * own roll-call answer (owner-ai.ts) is rollCallText over the same entries.
 * Names only: no token ids, tags or emails.
 */
import type { Present } from "./presence";
import { type ChatLaneDef, LANES } from "./voices";

export type RosterEntry = {
  /** Its lane id when the hub knows it, else its token's name: the role's key. */
  id: string;
  /** The name shown in the chat. */
  name: string;
  mode?: "listener" | "reader";
  muted?: true;
};

export const ROSTER_LIMITS = { entries: 16, name: 40 } as const;
/** The whole prompt addition (rules line included), in characters. */
export const ROSTER_MAX_CHARS = 400;

const clean = (v: unknown): string =>
  typeof v === "string"
    ? [...v.replace(/[\n\r<>【】]/gu, " ").trim()].slice(0, ROSTER_LIMITS.name).join("")
    : "";

/**
 * The participants of a presence list, Li (the main lane) and pages left out,
 * listeners first (otherwise the list's own order: most recent first), one per name.
 */
export function rosterOf(list: readonly Present[]): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const p of list) {
    if (p.lane === "main" || p.key.startsWith("page:")) continue;
    const name = clean(p.name);
    if (!name || out.some((e) => e.name === name)) continue;
    out.push({
      id: clean(p.lane ?? p.selfName ?? p.name) || name,
      name,
      ...(p.mode ? { mode: p.mode } : {}),
      ...(p.muted ? { muted: true as const } : {}),
    });
  }
  const rank = (e: RosterEntry) => (e.mode === "listener" ? 0 : 1);
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e)
    .slice(0, ROSTER_LIMITS.entries);
}

/** The hub's entries as the main Worker receives them, bounded; undefined when none are usable. */
export function parseRoster(raw: unknown): RosterEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RosterEntry[] = [];
  for (const r of raw.slice(0, ROSTER_LIMITS.entries)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = clean(o.name);
    if (!name) continue;
    out.push({
      id: clean(o.id) || name,
      name,
      ...(o.mode === "listener" || o.mode === "reader" ? { mode: o.mode } : {}),
      ...(o.muted === true ? { muted: true as const } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * A participant's role: its `chat.lanes` row's (by id, name or alias), else
 * the built-in lane's (LANES, by id or alias); undefined when none is known.
 */
export function laneRole(
  e: Pick<RosterEntry, "id" | "name">,
  table: readonly ChatLaneDef[] = [],
): string | undefined {
  const keys = [e.id.toLowerCase(), e.name.toLowerCase()];
  const row = table.find(
    (d) =>
      keys.includes(d.id.toLowerCase()) ||
      (d.name !== undefined && keys.includes(d.name.toLowerCase())) ||
      d.aliases?.some((a) => keys.includes(a)),
  );
  if (row?.role) return row.role;
  const builtIn = Object.entries(LANES).find(
    ([id, spec]) =>
      keys.includes(id) ||
      (row && row.id === id) ||
      (spec.name && keys.includes(spec.name.toLowerCase())) ||
      spec.aliases.some((a) => keys.includes(a)),
  );
  return builtIn?.[1].role;
}

const MODE_TEXT = { listener: "listening live", reader: "reads when named" } as const;

/**
 * The "who is here" block for Li's system prompt in the owner's thread, at
 * most ROSTER_MAX_CHARS: Li's own role, each participant (name, mode, muted,
 * role) while it fits, "+N more" for the rest, and the roll-call rule.
 */
export function rosterSection(
  entries: readonly RosterEntry[],
  table: readonly ChatLaneDef[] = [],
): string {
  const self = laneRole({ id: "main", name: "main" }, table);
  const head = `This is the developer's own thread. You are Li${self ? ` (${self})` : ""}; other agents (lanes) work here too. Present now:`;
  const rule =
    "On a roll call, answer that you are here and name who is present; never say you cannot.";
  const lines = entries.map((e) => {
    const tags = [e.mode && MODE_TEXT[e.mode], e.muted && "muted"].filter(Boolean).join(", ");
    const role = laneRole(e, table);
    return `- ${e.name}${tags ? ` (${tags})` : ""}${role ? `: ${role}` : ""}`;
  });
  const fixed = head.length + rule.length + 2;
  const kept: string[] = [];
  let len = fixed;
  for (let i = 0; i < lines.length; i++) {
    const more = lines.length - i - 1;
    // Room for this line, and for a "+N more" line after it when others follow.
    const tail = more ? `\n- +${more} more`.length : 0;
    if (len + lines[i].length + 1 + tail > ROSTER_MAX_CHARS) {
      kept.push(`- +${lines.length - i} more`);
      break;
    }
    kept.push(lines[i]);
    len += lines[i].length + 1;
  }
  if (!lines.length) kept.push("- nobody else");
  return [head, ...kept, rule].join("\n");
}

/**
 * Li's roll-call answer (config partner.rollCallReply): `{n}` = how many are
 * present besides Li, `{names}` = their names joined by 、. With nobody else,
 * only the template's first clause (the part before the separator ahead of `{n}`).
 */
export function rollCallText(template: string, entries: readonly RosterEntry[]): string {
  const names = entries.map((e) => e.name);
  if (!names.length) {
    const at = template.search(/\{n\}|\{names\}/);
    const head = at < 0 ? template : template.slice(0, at);
    const cut = head.search(/[，,；;。.][^，,；;。.]*$/u);
    return (cut > 0 ? head.slice(0, cut) : head).trim() || template.trim();
  }
  return template.replaceAll("{n}", String(names.length)).replaceAll("{names}", names.join("、"));
}
