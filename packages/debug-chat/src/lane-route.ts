/**
 * Which lane answers an owner line (docs/lane-listen.md). One matcher, used by
 * every listener: the chat lane's `eval.ts chat --route chat` and each lane's
 * `lianki-dev lane-listen`. So exactly one lane answers each line.
 *
 * Owner request, 2026-11-09 01:06 JST: codex and agy hear him directly, and
 * only the addressed lane answers. A name at the start of the line picks the
 * lane: "codex, …", "agy, …", "xiaoke, …" (the chat lane), with the spellings
 * speech-to-text makes of them in English and Chinese. A line with no name
 * goes to the chat lane only.
 *
 * Pure, tested in unit/lane-route.test.ts.
 */

import { longEnoughForOwn, nameSyllables, phoneticPrefix } from "./lane-phonetic";
import { type LaneId, laneTable, setLaneTable } from "./voices";
import { pinyinOf } from "./wake-tokens";

/**
 * The built-in route lanes. More come from config `chat.lanes` (voices.ts
 * setLaneTable): each configured lane routes under its own id (its token
 * name), so a route lane is any string routeLanes() lists.
 */
export const ROUTE_LANES = ["chat", "codex", "agy"] as const;
export type DefaultRouteLane = (typeof ROUTE_LANES)[number];
export type RouteLane = DefaultRouteLane | (string & {});

/** The chat lane each built-in route lane is (addressed.ts): "chat" is 小克's. */
const BUILTIN_ROUTE: Readonly<Record<string, DefaultRouteLane>> = {
  claude: "chat",
  codex: "codex",
  agy: "agy",
};
/** The route lane a chat lane (voices.ts LaneId) answers as: "claude" → "chat", "main" none, a configured one itself. */
export const routeOfLane = (id: LaneId): RouteLane | null =>
  id === "main" ? null : (BUILTIN_ROUTE[id] ?? id);
/** The chat lane a route lane is (the inverse): "chat" → "claude", the others themselves. */
export const laneOfRoute = (r: RouteLane): LaneId => (r === "chat" ? "claude" : r);

/** Every route lane: the built-ins, then the configured lanes (in their order). */
export function routeLanes(): RouteLane[] {
  const out: RouteLane[] = [...ROUTE_LANES];
  for (const d of laneTable()) {
    const r = routeOfLane(d.id);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}
export const isRouteLane = (v: unknown): v is RouteLane =>
  typeof v === "string" && routeLanes().includes(v);

/** The lane a line with no name goes to. */
export const DEFAULT_LANE: RouteLane = "chat";

/**
 * Each lane's names. `exact`: its own name, taken with any separator after it,
 * a space too ("codex 看一下"). `heard`: how STT writes it; these need a
 * punctuation mark or a CJK character after them, so a sentence that merely
 * starts with the word ("Codecs are…", "Gemini says…") is not addressed.
 * Latin names are matched case-insensitively with spaces, dots and hyphens
 * inside them ignored ("A. G. Y.", "Anti-gravity", "Xiao Ke").
 */
export type LaneNames = { readonly exact: readonly string[]; readonly heard: readonly string[] };
/** One lane's names (杰咪's wake-name table, 2026-11-15): the same shape as LaneNames. */
export type LaneNameEntry = LaneNames;
/** Route lane → its names: the built-ins' (LANE_NAMES) and the configured lanes'. */
export type LaneNamesTable = Readonly<
  Record<DefaultRouteLane, LaneNameEntry> & Partial<Record<string, LaneNameEntry>>
>;
export const LANE_NAMES: Readonly<Record<DefaultRouteLane, LaneNames>> = {
  codex: {
    // coco: the owner's name for codex (2026-11-14), written coco, never 可可.
    exact: ["codex", "coco"],
    heard: [
      "Q扣",
      "可可",
      "cocoa",
      "koko",
      "扣扣",
      "科科",
      "codecs",
      "codec",
      "kodex",
      "kodax",
      "codax",
      "扣德克斯",
      "寇德克斯",
      "蔻德克斯",
      "科德克斯",
      "柯德克斯",
      "抠德克斯",
      "扣得克斯",
      "扣的克斯",
      "口德克斯",
    ],
  },
  agy: {
    // 杰咪: the owner's name for agy (2026-11-14), 咪宝 (owner, 2026-11-15: "咪宝咪宝在吗").
    // 哈基米: his new name for agy (owner, 2026-11-16 02:03 JST); 杰咪 stays a name.
    exact: ["agy", "antigravity", "哈基米", "杰咪", "咪宝", "Jimmy", "jimmy"],
    heard: [
      // STT spellings of 哈基米 (2026-11-16: "你把自己改名为海吉米吧").
      "哈吉米",
      "海吉米",
      "哈急米",
      "哈几米",
      // STT 2026-11-16 13:3x JST: "韩吉敏回答。", "韩今明要实施监控这个页面的改动。"
      "韩吉敏",
      "韩今明",
      "韩吉明",
      "韩金明",
      "韩基米",
      "韩吉米",
      "汉吉米",
      "哈吉敏",
      "哈基敏",
      "哈吉明",
      "ハチミ",
      "ハッチミ",
      "Hajimi",
      "hajimi",
      "杰米",
      "洁咪",
      "解密",
      // STT on 2026-11-15 20:3x JST: "Jmy杰my听到了没", "解米都认识自己的名字".
      "解米",
      "姐咪",
      "揭米",
      "杰my",
      "杰mi",
      "jmy",
      "Jmy",
      "杰明",
      // STT 2026-11-15 22:3x JST: "建明建明在吗？"
      "建明",
      "剑明",
      "健明",
      "ajy",
      "aji",
      "反重力",
      "杰米尼",
      "哲米尼",
      "gemini",
      "诶吉歪",
      "欸吉歪",
      "诶居外",
    ],
  },
  chat: {
    // 小克: the lane's name (2026-11-14), also its @mention (polish.ts wakeMention).
    // Project/branch names also route to chat lane (lianki, liagent, agent-yes, otoji).
    // 小柯: his STT writes it often enough to be an own name (2026-11-15: "小柯你给Li配置一下" went unaddressed).
    exact: ["xiaoke", "小可", "小克", "小柯", "小客", "小贺", "小课", "小科", "lianki", "liagent", "agent-yes", "otoji"],
    // 小客, 小课: how STT wrote 小克 for him (owner, 2026-11-14).
    heard: ["xiaoko", "shiaoke", "小客", "小课", "小科", "晓可", "晓科", "小珂", "肖可"],
  },
};

/**
 * A route lane's names: the built-in ones with its config row's added (the
 * row's id, name and aliases are its own names; `heard` its STT spellings),
 * or, for a configured lane, the row's alone. One table for the routing, the
 * wake words (wake-names.ts) and the avatar flash (addressed.ts).
 */
export function laneNames(lane: RouteLane): LaneNames {
  const base: LaneNames = (LANE_NAMES as Record<string, LaneNames>)[lane] ?? { exact: [], heard: [] };
  const row = laneTable().find((d) => routeOfLane(d.id) === lane);
  if (!row) return base;
  const own = [row.id, ...(row.name ? [row.name] : []), ...(row.aliases ?? [])].map((n) =>
    n.toLowerCase(),
  );
  const exact = [...new Set([...base.exact, ...own])].filter((n) => n !== "main");
  return { exact, heard: [...new Set([...base.heard, ...(row.heard ?? [])])] };
}

/**
 * The whole effective table: every route lane (routeLanes) with its names
 * (laneNames). ONE source (owner, 2026-11-15): config `chat.lanes` rows on
 * top of LANE_NAMES; the wake names are the rows' `aliases` (and `heard`).
 */
export function getEffectiveLaneNames(): LaneNamesTable {
  return Object.fromEntries(routeLanes().map((l) => [l, laneNames(l)])) as LaneNamesTable;
}

/**
 * Wake names from a name → lane-names object (the shape `chat.laneNames`
 * had): an alias of the same data, written into the one lane table as
 * `chat.lanes` rows (exact → aliases, heard → heard, replacing that row's
 * wake names; the built-in names stay). `null` clears the table (the built-in names alone).
 */
export function setCustomLaneNames(
  table: Partial<Record<RouteLane, Partial<LaneNameEntry>>> | null,
): void {
  if (!table) {
    setLaneTable([]);
    return;
  }
  const rows = [...laneTable()];
  for (const [lane, names] of Object.entries(table)) {
    if (!names) continue;
    const id = laneOfRoute(lane);
    const i = rows.findIndex((r) => r.id === id);
    // Its wake names replace the row's; its name, voice and colour stay.
    const row = {
      ...(i >= 0 ? rows[i] : {}),
      id,
      aliases: [...(names.exact ?? [])],
      heard: [...(names.heard ?? [])],
    };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
  }
  setLaneTable(rows);
}

/**
 * All wake words and aliases across all lanes, for STT hotword lists or
 * prompts (stt-hint.ts formatSttPrompt): from the one effective table.
 */
export function laneHotwords(table: LaneNamesTable = getEffectiveLaneNames()): string[] {
  const words = new Set<string>();
  for (const names of Object.values(table)) {
    if (!names) continue;
    for (const name of names.exact) words.add(name);
    for (const name of names.heard) words.add(name);
  }
  return [...words];
}

/** What may come before the name: a wake word, a greeting, an @. */
const LEAD =
  /^(?:\s|@|[,，、:：.。!！~～-])*(?:(?:hey|hi|hello|ok|okay|yo|linky|lenky|林琪|嘿|喂|哎|诶|欸|那个)(?:\s|[,，、:：.。!！~～-])+)*/iu;
/** What may follow the name before the separator: "codex lane", "codex 线", "codex 同学", "codex 啊". */
const TAIL = /^(?:\s*(?:lane|线|同学|啊|呀|哈)(?![a-z]))?/iu;
/** Separators after a name. */
const PUNCT = /^[\s]*[,，、:：.。!！?？~～—–-]/u;
const SPACE = /^\s/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Between two names: "codex 和 agy", "@coco @杰咪". */
const JOIN = /^\s*(?:和|跟|与|还有|及|and|&|\+|\/|、|@)\s*/iu;

const isLatin = (name: string) => /^[a-z]+$/i.test(name);

type Hit = { lane: RouteLane; end: number; exact: boolean };

/** The longest lane name at the start of `s` (after nothing), or null. */
function nameAt(s: string): Hit | null {
  let best: Hit | null = null;
  for (const lane of routeLanes()) {
    const names = laneNames(lane);
    for (const kind of ["exact", "heard"] as const) {
      for (const name of names[kind]) {
        let end = -1;
        if (isLatin(name)) {
          // Walk the input, skipping spaces/dots/hyphens between letters, until the name is spelled.
          let i = 0;
          let j = 0;
          const n = name.toLowerCase();
          while (i < s.length && j < n.length) {
            const c = s[i]!.toLowerCase();
            if (c === n[j]) {
              i++;
              j++;
            } else if (j > 0 && /[\s.\-_·]/u.test(c)) i++;
            else break;
          }
          if (j === n.length) {
            // Not inside a longer latin word ("codexes", "agyle").
            if (!/^[a-z0-9]/i.test(s.slice(i))) end = i;
          }
        } else if (s.slice(0, name.length).toLowerCase() === name.toLowerCase()) end = name.length;
        // A heard Han spelling of enough syllables is said as the name is: no mark needed
        // (lane-phonetic.ts longEnoughForOwn, config lanes.phoneticOwnSyllables).
        if (end > 0 && (!best || end > best.end))
          best = { lane, end, exact: kind === "exact" || longEnoughForOwn(sylsOf(name)?.length) };
      }
    }
  }
  return best ?? phoneticAt(s);
}

const sylCache = new Map<string, string[] | null>();
/** A Han name's toneless syllables (lane-phonetic.ts), cached per spelling. */
function sylsOf(name: string): string[] | null {
  if (!sylCache.has(name)) sylCache.set(name, nameSyllables(name, pinyinOf));
  return sylCache.get(name)!;
}

/**
 * The fallback when no spelling matched: a lane name by sound (lane-phonetic.ts,
 * owner 2026-11-15: "从语音层面来"). Every Han name and heard spelling of every
 * lane is a pronunciation; the longest one `s` starts with wins. A sound match
 * counts as a heard spelling (a punctuation mark must follow it), unless it is
 * long enough to count as an own name (longEnoughForOwn: 3 syllables by default).
 */
function phoneticAt(s: string): Hit | null {
  let best: Hit | null = null;
  for (const lane of routeLanes()) {
    const names = laneNames(lane);
    for (const name of [...names.exact, ...names.heard]) {
      const syls = sylsOf(name);
      if (!syls) continue;
      const end = phoneticPrefix(s, syls, pinyinOf);
      if (end > 0 && (!best || end > best.end))
        best = { lane, end, exact: longEnoughForOwn(syls.length) };
    }
  }
  return best;
}

/**
 * After a name: the rest of the line if a separator follows as the name's kind
 * requires, else null (not addressed). Own names: a punctuation mark, a space,
 * a CJK character, or nothing. Heard spellings: a punctuation mark or nothing.
 * "codex的…" is talk about codex, not to it.
 */
function after(s: string, exact: boolean): string | null {
  const rest = s.slice(TAIL.exec(s)![0].length);
  if (!rest.trim()) return "";
  const p = PUNCT.exec(rest);
  if (p) return rest.slice(p[0].length).trimStart();
  if (!exact) return null;
  const t = rest.trimStart();
  if (t.startsWith("的")) return null;
  return CJK.test(t) || SPACE.test(rest) ? t : null;
}

export type Route = {
  /** The lanes that answer: the addressed ones, else [DEFAULT_LANE]. */
  lanes: RouteLane[];
  /** Whether the line named a lane. */
  addressed: boolean;
  /** An all-hands call (全体…, 都有报数): every lane, including ones this table does not list. */
  all?: true;
  /** The line without the names in front. */
  text: string;
};

/**
 * Which lanes answer `text`. A name (or several joined by 和 / and / & / 、)
 * at the start addresses those lanes; anything else goes to the chat lane.
 */
/** The all-hands word, with the separator that may follow it. */
const ALL = /^全体[，,、:：!！ ]*/;
/**
 * All hands further in (2026-11-15: "小朋友们全体都有包书一" went unaddressed, so Li
 * answered a roll call as the learning partner): 全体 within the first 12
 * characters, or 都有报数 anywhere. The whole line stays the text.
 */
const ALL_NEAR = /^[^\n]{0,12}?全体|都有报数/u;
export function routeLine(text: string): Route {
  const raw = typeof text === "string" ? text : "";
  const none: Route = { lanes: [DEFAULT_LANE], addressed: false, text: raw.trim() };
  let s = raw.replace(LEAD, "");
  // "全体…" at the start addresses every lane at once (owner, 2026-11-14:
  // "点名应该监听全体这两个字").
  const all = ALL.exec(s);
  if (all)
    return {
      lanes: routeLanes(),
      addressed: true,
      all: true,
      text: s.slice(all[0].length).trim(),
    };
  if (ALL_NEAR.test(s)) return { lanes: routeLanes(), addressed: true, all: true, text: s.trim() };
  const lanes: RouteLane[] = [];
  for (;;) {
    const hit = nameAt(s);
    if (!hit) return none;
    if (!lanes.includes(hit.lane)) lanes.push(hit.lane);
    let tail = s.slice(hit.end);
    // The same name said twice ("建明建明在吗？"): calling him, so it is an address
    // as an own name is, whatever spelling STT chose.
    const again = nameAt(tail);
    if (again && again.lane === hit.lane) {
      tail = tail.slice(again.end);
      hit.exact = true;
    }
    // Another name joined to this one: "codex 和 agy，…".
    const j = JOIN.exec(tail);
    if (j && j[0].trim() && nameAt(tail.slice(j[0].length))) {
      s = tail.slice(j[0].length);
      continue;
    }
    // The last name needs its separator, or none of them was an address
    // ("codex 和反重力的设计…" talks about them).
    const rest = after(tail, hit.exact);
    return rest === null ? none : { lanes, addressed: true, text: rest.trim() };
  }
}

/** A chat line as a listener sees it (eval.ts chat or `lianki chat listen`). */
export type RoutedMessage = { from?: unknown; thread?: unknown; text?: unknown };

/**
 * A marked test line: an agent line "[lane-test] codex, …" (after its own
 * 【lane】 tag), standing in for an owner line in the end-to-end test. Only a
 * listener started with --tests takes it; nothing else does.
 */
export const TEST_MARK = "[lane-test]";
export function testText(m: RoutedMessage): string | null {
  if (m.from !== "agent" || typeof m.text !== "string") return null;
  const t = m.text.replace(/^\s*【[^】\n]{1,24}】\s*/u, "");
  return t.startsWith(TEST_MARK) ? t.slice(TEST_MARK.length).trim() : null;
}

/**
 * Should `lane`'s listener take this line? Owner lines in the owner thread
 * that route to it (with `all`, every owner line there); with `tests`, also
 * marked test lines. Agent lines, friend lines and other threads never.
 */
export function laneTakes(
  lane: RouteLane,
  m: RoutedMessage,
  opts: { tests?: boolean; all?: boolean } = {},
): boolean {
  if ((m.thread ?? "owner") !== "owner") return false;
  let text: string | null = null;
  if (m.from === "owner" && typeof m.text === "string") text = m.text;
  else if (opts.tests) text = testText(m);
  if (text === null) return false;
  // `all`: every owner line, addressed or not (owner, 2026-11-14: "coco 也要听所有的话").
  return (opts.all === true && m.from === "owner") || routeLine(text).lanes.includes(lane);
}

/** A name inside a line: Latin ones as whole words, the others as written. */
function namedIn(t: string, name: string): boolean {
  const n = name.toLowerCase();
  if (!n) return false;
  if (!isLatin(n)) return t.includes(n);
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) {
    const before = i > 0 ? t[i - 1]! : "";
    const next = t[i + n.length] ?? "";
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(next)) return true;
  }
  return false;
}

/**
 * Does this line name a lane at all, as an address or not (owner,
 * 2026-11-16: Li answered "韩今明要实施监控这个页面的改动", a heard spelling
 * of 哈基米 with no mark after it)? Broader than routeLine: any own name or
 * heard spelling anywhere in the line, and a name by sound at its start
 * without the mark. Used only to keep Li (the Learning Partner model) quiet,
 * so a false hit costs a silence, never a wrong hand-off.
 */
export function namesLane(text: string): boolean {
  const raw = typeof text === "string" ? text : "";
  if (routeLine(raw).addressed) return true;
  const t = raw.toLowerCase();
  for (const lane of routeLanes()) {
    const names = laneNames(lane);
    for (const name of [...names.exact, ...names.heard]) if (namedIn(t, name)) return true;
  }
  return nameAt(raw.replace(LEAD, "")) !== null;
}
