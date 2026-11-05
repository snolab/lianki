// Cleaning notification prefixes out of page titles (owner, 2026-11-06 00:15
// JST): "(99+ 封私信 / 38 条消息) 怎么能让书里的信息成为自己的知识呢？ - 知乎" is
// the question's title with a counter in front that changes on every visit.
//
// One generic matcher, the rules are data (docs/title-clean.md). Rules can come
// from synced preferences and run on every page the userscript runs on, so they
// are untrusted input, and JavaScript regex has no timeout. Hence no RegExp is
// ever built from a rule: a pattern compiles to a short token list, and the
// matcher walks it forwards once, with no backtracking.
//
//   #     a number of 1 or 2 digits, and no more ("(2024)" is not "(#)")
//   ##    a number of up to 4 digits, which may end in +
//   *     short text up to the literal that follows, never past a closing bracket
//   space any spacing, or none
//   \x    the character x itself (\# \* \\)
//
// Anything else is literal, ignoring case and full-width forms: "(" matches "（".
// A pattern only ever matches at the start of a title.
//
// Free of Next, the DOM and the rest of core: the userscript deep-imports it.

export type TitleRule = {
  /** A site and its subdomains ("zhihu.com"); "" means every site. */
  host: string;
  pattern: string;
};

/**
 * What the account stores (`titles.rules`): a difference from the defaults, not
 * a list. Someone who never edits keeps getting the defaults as they improve,
 * and it stays under the 2 KB a preference may hold.
 */
export type TitleRulesPref = {
  /** ids (titleRuleId) of the default rules this user removed. */
  off: string[];
  /** Their own rules. */
  add: TitleRule[];
};

export const TITLE_PATTERN_MAX = 48;
export const TITLE_HOST_MAX = 40;
export const TITLE_RULES_ADD_MAX = 10;
export const TITLE_RULES_OFF_MAX = 64;

/** How far into a title matching looks. A prefix is short; a huge title costs nothing. */
const WINDOW = 512;
/** How far one * reaches. */
const ANY_MAX = 64;
const ANY_PER_PATTERN = 3;
/** "(3) (5) Foo": stacked prefixes, bounded. */
const PASSES = 3;
const RULES_MAX = 128;

const on = (host: string, ...patterns: string[]): TitleRule[] =>
  patterns.map((pattern) => ({ host, pattern }));

/** A bare count is only a count where the site is known to put one there. */
const COUNTING_SITES = [
  "youtube.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "discord.com",
  "quora.com",
  "twitch.tv",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
  "web.whatsapp.com",
  "web.telegram.org",
];

export const DEFAULT_TITLE_RULES: readonly TitleRule[] = [
  // Every site: only shapes a real title does not take. All nines and a plus is
  // a capped badge; "(18+)" is an age rating and stays. A number with the word
  // for what it counts says so itself; "(1984)" and "(Part 2)" do not.
  ...on(
    "",
    "(9+)",
    "(99+)",
    "(999+)",
    "(## new)",
    "(## unread)",
    "(## message)",
    "(## messages)",
    "(## new message)",
    "(## new messages)",
    "(## notification)",
    "(## notifications)",
    "(## 条消息)",
    "(## 条新消息)",
    "(## 条未读)",
    "(## 条通知)",
    "(## 条私信)",
    "(## 封私信)",
    "(## 件の通知)",
    "(## 件の新着)",
    "(## 개의 알림)",
  ),
  // "(99+ 封私信 / 38 条消息)", "(38 条消息)", "(2 封私信)".
  ...on("zhihu.com", "(##*条消息)", "(##*封私信)"),
  ...COUNTING_SITES.flatMap((host) => on(host, "(#)")),
  // These two cap their badge at a round number: "(20+) Facebook".
  ...on("facebook.com", "(#)", "(#+)"),
  ...on("x.com", "(#)", "(#+)"),
  ...on("twitter.com", "(#)", "(#+)"),
];

/** A default rule's stable id: FNV-1a of its text, so editing a rule makes it a new one. */
export function titleRuleId(rule: TitleRule): string {
  const s = `${rule.host}|${rule.pattern}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── Compiling ─────────────────────────────────────────────────────────────

type Token =
  | { k: "lit"; s: string }
  | { k: "space" }
  | { k: "num"; max: number; plus: boolean }
  | { k: "any" };

const isSpace = (c: number) =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x3000 ||
  c === 0x200b ||
  c === 0xfeff;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/** Same length as its input: case and full-width forms folded, one unit for one. */
function fold(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xff01 && c <= 0xff5e) {
      const ascii = String.fromCharCode(c - 0xfee0).toLowerCase();
      out += ascii;
    } else if (c === 0x3010 || c === 0x3014) out += "[";
    else if (c === 0x3011 || c === 0x3015) out += "]";
    else {
      const ch = s[i];
      const lower = ch.toLowerCase();
      out += lower.length === 1 ? lower : ch;
    }
  }
  return out;
}

/** The tokens of a pattern, or null for one that cannot be used. */
function compile(pattern: unknown): Token[] | null {
  if (typeof pattern !== "string" || pattern.length > TITLE_PATTERN_MAX) return null;
  // Nothing that names a place reaches the account's stored values (prefs-sync.md, 5).
  if (/:\/\/|^\/\/|\.ts\.net|localhost|127\.0\.0\.1/i.test(pattern)) return null;
  const tokens: Token[] = [];
  let lit = "";
  const flush = () => {
    if (lit) tokens.push({ k: "lit", s: fold(lit) });
    lit = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      if (i >= pattern.length) return null;
      lit += pattern[i];
    } else if (ch === "#") {
      flush();
      if (pattern[i + 1] === "#") {
        i++;
        tokens.push({ k: "num", max: 4, plus: true });
      } else tokens.push({ k: "num", max: 2, plus: false });
    } else if (ch === "*") {
      flush();
      tokens.push({ k: "any" });
    } else if (isSpace(pattern.charCodeAt(i))) {
      flush();
      tokens.push({ k: "space" });
    } else lit += ch;
  }
  flush();

  while (tokens[0]?.k === "space") tokens.shift();
  while (tokens[tokens.length - 1]?.k === "space") tokens.pop();
  if (!tokens.length || tokens[0].k === "any") return null;
  if (tokens.filter((t) => t.k === "any").length > ANY_PER_PATTERN) return null;

  // A * ends at the literal after it: that is what makes it a single scan.
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    out.push(t);
    if (t.k !== "any") continue;
    while (tokens[i + 1]?.k === "space") i++;
    if (tokens[i + 1]?.k !== "lit") return null;
  }
  return out;
}

export const isTitlePattern = (pattern: unknown): pattern is string => compile(pattern) !== null;

/** The form a site is stored in, or null: a public host, nothing that names a device. */
export function titleHostOf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (host.length > TITLE_HOST_MAX) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/\.ts\.net$|\.local$|\.internal$|\.\d+$/.test(host)) return null;
  return host;
}

/** Is this a value `titles.rules` may hold as a host: already in stored form, or every site? */
export const isTitleHost = (host: unknown): host is string =>
  host === "" || (typeof host === "string" && titleHostOf(host) === host);

// ── Matching ──────────────────────────────────────────────────────────────

/** Where a match starting at `from` ends, or -1. One forward walk, no retries. */
function matchAt(tokens: readonly Token[], text: string, from: number): number {
  let i = from;
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n];
    if (t.k === "lit") {
      if (!text.startsWith(t.s, i)) return -1;
      i += t.s.length;
    } else if (t.k === "space") {
      while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    } else if (t.k === "num") {
      const start = i;
      while (i < text.length && isDigit(text.charCodeAt(i))) {
        i++;
        if (i - start > t.max) return -1;
      }
      if (i === start) return -1;
      if (t.plus && text[i] === "+") i++;
    } else {
      // compile() guarantees a literal comes next. Its first place wins.
      const next = (tokens[n + 1] as { s: string }).s;
      const limit = Math.min(i + ANY_MAX, text.length);
      let found = -1;
      for (let j = i; j <= limit; j++) {
        if (text.startsWith(next, j)) {
          found = j;
          break;
        }
        const c = text[j];
        if (c === ")" || c === "]" || c === "\n") return -1;
      }
      if (found < 0) return -1;
      i = found;
    }
  }
  return i;
}

type Compiled = { host: string; tokens: Token[] };
const compiledOf = new WeakMap<readonly TitleRule[], Compiled[]>();

function compileRules(rules: readonly TitleRule[]): Compiled[] {
  let c = compiledOf.get(rules);
  if (c) return c;
  c = [];
  for (const r of rules.slice(0, RULES_MAX)) {
    const tokens = compile(r?.pattern);
    if (tokens) c.push({ host: typeof r.host === "string" ? r.host : "", tokens });
  }
  compiledOf.set(rules, c);
  return c;
}

function hostFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const onHost = (ruleHost: string, host: string) =>
  ruleHost === "" || host === ruleHost || host.endsWith(`.${ruleHost}`);

/** Does this have something of a title left? Punctuation and spacing alone do not count. */
const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);

/**
 * The title without its notification prefix. One that would become empty, and
 * one nothing matches, comes back exactly as it was.
 */
export function cleanTitle(
  title: string,
  opts: { url?: string | null; rules?: readonly TitleRule[] } = {},
): string {
  if (typeof title !== "string" || !title) return title;
  const rules = opts.rules ?? DEFAULT_TITLE_RULES;
  const host = hostFromUrl(opts.url);
  const usable = compileRules(rules).filter((r) => onHost(r.host, host));
  if (!usable.length) return title;

  const text = fold(title.slice(0, WINDOW));
  const skipSpace = (i: number) => {
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    return i;
  };
  let at = skipSpace(0);
  let cut = -1;
  for (let pass = 0; pass < PASSES; pass++) {
    let end = -1;
    for (const r of usable) {
      end = matchAt(r.tokens, text, at);
      if (end >= 0) break;
    }
    if (end < 0) break;
    at = skipSpace(end);
    cut = at;
  }
  if (cut < 0) return title;
  const rest = title.slice(cut);
  return hasWords(rest) ? rest : title;
}

const BARE_COUNT = compile("(##)") as Token[];

/** "(3) Foo" into its number and the rest. */
function splitCount(title: string): { n: string; rest: string } | null {
  const text = fold(title.slice(0, WINDOW));
  const end = matchAt(BARE_COUNT, text, 0);
  if (end < 0) return null;
  const rest = title.slice(end).trimStart();
  return rest && hasWords(rest) ? { n: text.slice(0, end), rest } : null;
}

/**
 * The other way to know a number is a counter, on a site no rule knows: the
 * same page was seen before with a different number or none. Needs a stored
 * title, so it works when a card is saved again, not at display.
 */
export function dropCountSeenChanging(current: string, stored: string | null | undefined): string {
  if (!stored || typeof current !== "string") return current;
  const now = splitCount(current);
  if (!now) return current;
  if (stored.trim() === now.rest) return now.rest;
  const then = splitCount(stored);
  return then && then.n !== now.n && then.rest === now.rest ? now.rest : current;
}

// ── The preference ────────────────────────────────────────────────────────

/** Coerce an untrusted value, keeping what is valid and within the caps. */
export function parseTitleRulesPref(v: unknown): TitleRulesPref {
  const o = (v && typeof v === "object" ? v : {}) as { off?: unknown; add?: unknown };
  const off = (Array.isArray(o.off) ? o.off : [])
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f]{8}$/.test(id))
    .slice(0, TITLE_RULES_OFF_MAX);
  const add = (Array.isArray(o.add) ? o.add : [])
    .filter(
      (r): r is TitleRule => !!r && isTitleHost((r as TitleRule).host) && isTitlePattern(r.pattern),
    )
    .slice(0, TITLE_RULES_ADD_MAX)
    .map((r) => ({ host: r.host, pattern: r.pattern }));
  return { off, add };
}

const activeOf = new WeakMap<object, readonly TitleRule[]>();

/** The rules in force for a stored preference: the defaults it kept, then its own. */
export function activeTitleRules(pref: unknown): readonly TitleRule[] {
  if (!pref || typeof pref !== "object") return DEFAULT_TITLE_RULES;
  const memo = activeOf.get(pref);
  if (memo) return memo;
  const { off, add } = parseTitleRulesPref(pref);
  const rules =
    !off.length && !add.length
      ? DEFAULT_TITLE_RULES
      : [...DEFAULT_TITLE_RULES.filter((r) => !off.includes(titleRuleId(r))), ...add];
  activeOf.set(pref, rules);
  return rules;
}
