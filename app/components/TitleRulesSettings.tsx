"use client";

// Settings → Page titles (docs/title-clean.md): the patterns that take
// notification prefixes such as "(3) " off page titles. Saved at once and
// follows the account (`titles.rules`); what is stored is the difference from
// the defaults, so removing a default and restoring it leave nothing behind.

import { useCallback, useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import {
  activeTitleRules,
  cleanTitle,
  DEFAULT_TITLE_RULES,
  isTitlePattern,
  titleHostOf,
  titleRuleId,
  TITLE_PATTERN_MAX,
  TITLE_RULES_ADD_MAX,
  type TitleRule,
  type TitleRulesPref,
} from "@lianki/core/titleClean";
import { readTitleRulesPref, TITLE_RULES_KEY } from "@/lib/titles/client";

const FIELD =
  "w-full rounded-lg border border-[oklch(0.5_0.02_250/0.35)] bg-[oklch(1_0_0/0.6)] px-3 py-2 text-base outline-none focus:border-[oklch(0.6_0.14_250)] focus:ring-1 focus:ring-[oklch(0.6_0.14_250)] dark:bg-[oklch(0.25_0.01_250/0.6)]";
const BTN =
  "min-h-11 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-50 pointer-fine:min-h-9";
const QUIET = `${BTN} bg-[oklch(0.5_0.02_250/0.12)] hover:bg-[oklch(0.5_0.02_250/0.2)]`;
const ERR = "text-sm text-[oklch(0.52_0.17_30)] dark:text-[oklch(0.76_0.14_30)]";
const SAMPLE = "(99+ 封私信 / 38 条消息) 怎么能让书里的信息成为自己的知识呢？ - 知乎";

function Row({
  rule,
  anySite,
  remove,
  onRemove,
}: {
  rule: TitleRule;
  anySite: React.ReactNode;
  remove: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-[oklch(0.5_0.02_250/0.08)] px-3 py-1">
      <code className="min-w-0 flex-1 break-all text-sm">{rule.pattern}</code>
      <span className="min-w-0 truncate text-xs opacity-70">{rule.host || anySite}</span>
      <button type="button" className={`${QUIET} shrink-0`} onClick={onRemove}>
        {remove}
      </button>
    </li>
  );
}

export function TitleRulesSettings() {
  const c = useIntlayer("title-rules");
  const [pref, setPref] = useState<TitleRulesPref>({ off: [], add: [] });
  const [host, setHost] = useState("");
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tryTitle, setTryTitle] = useState(SAMPLE);
  const [trySite, setTrySite] = useState("zhihu.com");

  const reload = useCallback(() => setPref(readTitleRulesPref()), []);
  useEffect(() => {
    reload();
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "titles.rules") reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === TITLE_RULES_KEY) reload();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener("storage", onStorage);
    };
  }, [reload]);

  const save = (next: TitleRulesPref) => {
    setPref(next);
    try {
      localStorage.setItem(TITLE_RULES_KEY, JSON.stringify(next));
    } catch {}
    notePrefWrite();
  };

  const add = () => {
    const p = pattern.trim();
    const h = host.trim() ? titleHostOf(host) : "";
    if (h === null) return setError(c.errHost.value);
    if (!isTitlePattern(p)) return setError(c.errPattern.value);
    if (pref.add.length >= TITLE_RULES_ADD_MAX) {
      return setError(c.errFull.value.replace("{max}", String(TITLE_RULES_ADD_MAX)));
    }
    setError(null);
    setPattern("");
    setHost("");
    if (pref.add.some((r) => r.host === h && r.pattern === p)) return;
    save({ ...pref, add: [...pref.add, { host: h, pattern: p }] });
  };

  const builtIn = DEFAULT_TITLE_RULES.filter((r) => !pref.off.includes(titleRuleId(r)));
  const after = cleanTitle(tryTitle, {
    url: `https://${titleHostOf(trySite) ?? "invalid.invalid"}/`,
    rules: activeTitleRules(pref),
  });

  return (
    <section className="mb-10 max-w-xl" data-section="title-rules" data-testid="title-rules">
      <h2 className="mb-2 text-2xl font-semibold">{c.heading}</h2>
      <p className="mb-2 opacity-80">{c.intro}</p>
      <p className="mb-4 text-sm opacity-70">{c.syntax}</p>

      <h3 className="mb-2 font-medium">{c.tryHeading}</h3>
      <div className="mb-6 space-y-2">
        <label className="block text-sm">
          {c.tryTitle}
          <input
            className={FIELD}
            value={tryTitle}
            onChange={(e) => setTryTitle(e.target.value)}
            data-testid="title-rules-try"
          />
        </label>
        <label className="block text-sm">
          {c.siteLabel}
          <input
            className={FIELD}
            value={trySite}
            onChange={(e) => setTrySite(e.target.value)}
            placeholder="example.com"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <dl className="rounded-lg bg-[oklch(0.5_0.02_250/0.08)] p-3 text-sm">
          <dt className="opacity-70">{c.before}</dt>
          <dd className="mb-2 break-words">{tryTitle}</dd>
          <dt className="opacity-70">{c.after}</dt>
          <dd className="break-words font-medium" data-testid="title-rules-after">
            {after}
          </dd>
        </dl>
        {after === tryTitle && <p className="text-sm opacity-70">{c.unchanged}</p>}
      </div>

      <h3 className="mb-2 font-medium">{c.yours}</h3>
      {pref.add.length === 0 ? (
        <p className="mb-3 text-sm opacity-70">{c.emptyYours}</p>
      ) : (
        <ul className="mb-3 space-y-1">
          {pref.add.map((r) => (
            <Row
              key={`${r.host}|${r.pattern}`}
              rule={r}
              anySite={c.anySite}
              remove={c.remove}
              onRemove={() => save({ ...pref, add: pref.add.filter((x) => x !== r) })}
            />
          ))}
        </ul>
      )}
      <form
        className="mb-6 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label className="block text-sm">
          {c.patternLabel}
          <input
            className={FIELD}
            value={pattern}
            maxLength={TITLE_PATTERN_MAX}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="(#)"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="title-rules-pattern"
          />
        </label>
        <label className="block text-sm">
          {c.siteLabel}
          <input
            className={FIELD}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="title-rules-host"
          />
        </label>
        {error && <p className={ERR}>{error}</p>}
        <button
          type="submit"
          className={`${BTN} bg-[oklch(0.55_0.15_250)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.15_250)]`}
          disabled={!pattern.trim()}
        >
          {c.add}
        </button>
      </form>

      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="font-medium">{c.builtIn}</h3>
        <button
          type="button"
          className={QUIET}
          disabled={pref.off.length === 0}
          onClick={() => save({ ...pref, off: [] })}
          data-testid="title-rules-restore"
        >
          {c.restore}
        </button>
      </div>
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {builtIn.map((r) => (
          <Row
            key={titleRuleId(r)}
            rule={r}
            anySite={c.anySite}
            remove={c.remove}
            onRemove={() => save({ ...pref, off: [...pref.off, titleRuleId(r)] })}
          />
        ))}
      </ul>
    </section>
  );
}
