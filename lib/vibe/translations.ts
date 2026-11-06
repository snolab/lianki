// Each finished line of a /vibe conversation in the conversation's other languages
// (docs/vibe.md, "Translations"). Pure, with the network injected: which languages,
// which lines, and a small queue. The rules, data-free: no fixed pair, no
// per-language code, a line is never translated into its own language.

/** On the account (lib/prefs/bindings.ts): a language counts above this share. */
export const MIN_SHARE_KEY = "lk:vibe-translate-min-pct";
export const MIN_SHARE_DEFAULT = 20;
export const MIN_SHARE_MIN = 1;
export const MIN_SHARE_MAX = 99;

/** A share from the outside: a whole percentage in range, else the default. */
export function checkShare(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= MIN_SHARE_MIN && (v as number) <= MIN_SHARE_MAX
    ? (v as number)
    : MIN_SHARE_DEFAULT;
}

/** The user's setting, on this device's copy of the account's preferences. */
export function readShare(): number {
  try {
    const raw = localStorage.getItem(MIN_SHARE_KEY);
    return raw === null ? MIN_SHARE_DEFAULT : checkShare(Number(raw));
  } catch {
    return MIN_SHARE_DEFAULT;
  }
}

/**
 * The conversation's languages: any making up more than `minPct` percent of the
 * lines so far with a detected language. With one language, nothing to translate into.
 */
export function conversationLangs(
  langs: readonly (string | null | undefined)[],
  minPct: number = MIN_SHARE_DEFAULT,
): string[] {
  const n = new Map<string, number>();
  let total = 0;
  for (const l of langs) {
    if (!l) continue;
    n.set(l, (n.get(l) ?? 0) + 1);
    total++;
  }
  return [...n]
    .filter(([, c]) => (c * 100) / total > minPct)
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);
}

/** What one line goes into: the conversation's languages but its own. */
export const targetsOf = (lineLang: string | null | undefined, langs: readonly string[]) =>
  lineLang ? langs.filter((l) => l !== lineLang) : [];

export type TranslationRow = { line: string; target: string; out: string };
export type Asked = string | "failed" | "asking";
type Line = { text: string; lang?: string };

export type TranslatorDeps = {
  /** The translation, null when it failed, "wait" when the server says it is paused. */
  ask(text: string, to: string, from: string): Promise<string | null | "wait">;
  /** May anything be sent right now? Paused, or a log only being read: no. */
  canRun(): boolean;
  minPct(): number;
  onChange(): void;
  concurrency?: number;
};

const keyOf = (text: string, to: string) => `${to}\u0000${text}`;

/**
 * Newest line first, two at a time. A language that reaches its share later brings
 * the earlier lines along. A failure stays a failure: it shows, and is not asked
 * again by itself, so nothing can spend in a loop.
 */
export function createTranslator(d: TranslatorDeps, known: readonly TranslationRow[] = []) {
  const held = new Map<string, Asked>();
  for (const r of known) held.set(keyOf(r.line, r.target), r.out);
  let lines: readonly Line[] = [];
  let active = 0;

  const nextJob = (): { text: string; to: string; from: string } | null => {
    const langs = conversationLangs(
      lines.map((l) => l.lang),
      d.minPct(),
    );
    for (let i = lines.length - 1; i >= 0; i--) {
      const { text, lang } = lines[i];
      for (const to of targetsOf(lang, langs))
        if (!held.has(keyOf(text, to))) return { text, to, from: lang! };
    }
    return null;
  };

  const pump = () => {
    while (active < (d.concurrency ?? 2) && d.canRun()) {
      const job = nextJob();
      if (!job) return;
      const k = keyOf(job.text, job.to);
      held.set(k, "asking");
      active++;
      void d
        .ask(job.text, job.to, job.from)
        .catch(() => null)
        .then((out) => {
          active--;
          if (out === "wait") held.delete(k);
          else held.set(k, out ?? "failed");
          d.onChange();
          if (out !== "wait") pump();
        });
      d.onChange();
    }
  };

  return {
    /** The lines as they are now; sends what is missing, if it may. */
    update(next: readonly Line[]) {
      lines = next;
      pump();
    },
    /** What this line shows in this language: nothing yet, its text, or a failure. */
    get: (text: string, to: string): Asked | undefined => held.get(keyOf(text, to)),
    /** Every language this line has or will have, in the conversation's order. */
    shownFor(line: Line): string[] {
      const langs = conversationLangs(
        lines.map((l) => l.lang),
        d.minPct(),
      );
      const out = targetsOf(line.lang, langs);
      // Translated when its language still counted: it stays.
      for (const k of held.keys()) {
        const cut = k.indexOf("\u0000");
        const to = k.slice(0, cut);
        if (k.slice(cut + 1) === line.text && !out.includes(to) && to !== line.lang) out.push(to);
      }
      return out;
    },
  };
}
