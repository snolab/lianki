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

export const ROUTE_LANES = ["chat", "codex", "agy"] as const;
export type RouteLane = (typeof ROUTE_LANES)[number];
export const isRouteLane = (v: unknown): v is RouteLane =>
  typeof v === "string" && (ROUTE_LANES as readonly string[]).includes(v);

/** The lane a line with no name goes to. */
export const DEFAULT_LANE: RouteLane = "chat";

export type LaneNameEntry = {
  readonly exact: readonly string[];
  readonly heard: readonly string[];
};

export type LaneNamesTable = Record<RouteLane, LaneNameEntry>;

/**
 * Each lane's names. `exact`: its own name, taken with any separator after it,
 * a space too ("codex 看一下"). `heard`: how STT writes it; these need a
 * punctuation mark or a CJK character after them, so a sentence that merely
 * starts with the word ("Codecs are…", "Gemini says…") is not addressed.
 * Latin names are matched case-insensitively with spaces, dots and hyphens
 * inside them ignored ("A. G. Y.", "Anti-gravity", "Xiao Ke").
 */
export const LANE_NAMES: Readonly<LaneNamesTable> = {
  codex: {
    // coco: the owner's name for codex (2026-11-14), written coco, never 可可.
    exact: ["codex", "coco"],
    heard: [
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
    exact: ["agy", "antigravity", "杰咪", "咪宝"],
    heard: [
      "杰米",
      "洁咪",
      "解密",
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
    exact: ["xiaoke", "小可", "小克", "lianki", "liagent", "agent-yes", "otoji"],
    // 小客, 小课: how STT wrote 小克 for him (owner, 2026-11-14).
    heard: ["xiaoko", "shiaoke", "小客", "小课", "小科", "小柯", "晓可", "晓科", "小珂", "肖可"],
  },
};

/** Dynamic custom lane names configured live (e.g. from cfg("chat.laneNames")). */
let customLaneNames: LaneNamesTable | null = null;

/**
 * Configure dynamic custom lane names.
 * Setting `null` reverts to default LANE_NAMES.
 */
export function setCustomLaneNames(table: Partial<Record<RouteLane, Partial<LaneNameEntry>>> | null): void {
  if (!table) {
    customLaneNames = null;
    return;
  }
  const merged: LaneNamesTable = {
    codex: {
      exact: [...(table.codex?.exact ?? LANE_NAMES.codex.exact)],
      heard: [...(table.codex?.heard ?? LANE_NAMES.codex.heard)],
    },
    agy: {
      exact: [...(table.agy?.exact ?? LANE_NAMES.agy.exact)],
      heard: [...(table.agy?.heard ?? LANE_NAMES.agy.heard)],
    },
    chat: {
      exact: [...(table.chat?.exact ?? LANE_NAMES.chat.exact)],
      heard: [...(table.chat?.heard ?? LANE_NAMES.chat.heard)],
    },
  };
  customLaneNames = merged;
}

/**
 * The effective lane names table currently in use (custom overrides or LANE_NAMES defaults).
 */
export function getEffectiveLaneNames(): LaneNamesTable {
  return customLaneNames ?? LANE_NAMES;
}

/**
 * All wake words and aliases across all lanes, useful for STT hotword lists or prompts.
 */
export function laneHotwords(table: LaneNamesTable = getEffectiveLaneNames()): string[] {
  const words = new Set<string>();
  for (const lane of ROUTE_LANES) {
    for (const name of table[lane].exact) words.add(name);
    for (const name of table[lane].heard) words.add(name);
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
  const table = getEffectiveLaneNames();
  let best: Hit | null = null;
  for (const lane of ROUTE_LANES) {
    for (const kind of ["exact", "heard"] as const) {
      for (const name of table[lane][kind]) {
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
        } else if (s.startsWith(name)) end = name.length;
        if (end > 0 && (!best || end > best.end)) best = { lane, end, exact: kind === "exact" };
      }
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
  /** The line without the names in front. */
  text: string;
};

/**
 * Which lanes answer `text`. A name (or several joined by 和 / and / & / 、)
 * at the start addresses those lanes; anything else goes to the chat lane.
 */
/** The all-hands word, with the separator that may follow it. */
const ALL = /^全体[，,、:：!！ ]*/;
export function routeLine(text: string): Route {
  const raw = typeof text === "string" ? text : "";
  const none: Route = { lanes: [DEFAULT_LANE], addressed: false, text: raw.trim() };
  let s = raw.replace(LEAD, "");
  // "全体…" at the start addresses every lane at once (owner, 2026-11-14:
  // "点名应该监听全体这两个字").
  const all = ALL.exec(s);
  if (all) return { lanes: [...ROUTE_LANES], addressed: true, text: s.slice(all[0].length).trim() };
  const lanes: RouteLane[] = [];
  for (;;) {
    const hit = nameAt(s);
    if (!hit) return none;
    if (!lanes.includes(hit.lane)) lanes.push(hit.lane);
    const tail = s.slice(hit.end);
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
