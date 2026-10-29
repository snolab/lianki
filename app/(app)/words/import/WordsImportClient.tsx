"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { appHref } from "@/lib/app-locale";
import {
  buildEntries,
  guessLang,
  guessMapping,
  IMPORT_LANGS,
  MAX_ENTRIES,
  remapByName,
  ROLES,
  stripAnki,
  type BuildResult,
  type FieldMapping,
  type Role,
} from "@/lib/words/anki";
import { ApkgError, mainModel, parseApkg, type ApkgDeck, type ApkgPackage } from "@/lib/words/apkg";
import { downloadCatalog } from "@/lib/words/catalog-cache";
import type { WordList } from "@/lib/repos/wordsD1";

/** One deck of the file, as the user has set it up for import. */
type Plan = {
  deck: ApkgDeck;
  /** Field names of the deck's main note type. */
  fields: string[];
  mapping: FieldMapping;
  name: string;
  lang: string;
  /** An imported list to update, or "" for a new list. */
  target: string;
};
type Outcome = { listId: string; added: number; updated: number; unchanged: number };

/** A dictionary entry as a string (useIntlayer gives nodes whose text is `.value`). */
const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);
const fill = (s: unknown, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

const loadSql = async () =>
  (await import("sql.js")).default({ locateFile: () => "/sql-wasm.wasm" });

/** The deck's notes with the mapping applied (other note types matched by field name). */
function build(pkg: ApkgPackage, plan: Plan): BuildResult {
  const main = mainModel(plan.deck);
  return buildEntries(
    plan.deck.notes.map((n) => ({
      guid: n.guid,
      fields: n.fields,
      mapping:
        n.modelId === main
          ? plan.mapping
          : remapByName(plan.mapping, plan.fields, pkg.models[n.modelId]?.fields ?? []),
    })),
  );
}

function planFor(pkg: ApkgPackage, deck: ApkgDeck, lists: WordList[]): Plan {
  const fields = pkg.models[mainModel(deck)]?.fields ?? [];
  const mapping = guessMapping(fields);
  const terms = deck.notes.slice(0, 300).map((n) => stripAnki(n.fields[mapping.term] ?? ""));
  const name = deck.name.split("::").pop() || deck.name;
  // The same deck imported before: update that list by default.
  const existing = lists.find((l) => l.source === `anki:${deck.id}`);
  return {
    deck,
    fields,
    mapping,
    name: existing?.name ?? name,
    lang: existing?.lang ?? guessLang(deck.name, terms),
    target: existing?.id ?? "",
  };
}

export default function WordsImportClient() {
  const t = useIntlayer("words-import");
  const { locale } = useLocale();
  const [lists, setLists] = useState<WordList[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [stage, setStage] = useState<"idle" | "parsing" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pkg, setPkg] = useState<ApkgPackage | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadLists = async () => {
    const r = await fetch("/api/words/lists");
    if (r.status === 401) {
      setSignedOut(true);
      return [];
    }
    const { lists } = (await r.json()) as { lists: WordList[] };
    setLists(lists);
    return lists;
  };
  useEffect(() => {
    loadLists().catch(() => setLists([]));
  }, []);

  // A file dropped outside the drop zone must not navigate away from the page.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const open = async (file: File) => {
    setError(null);
    setOutcomes({});
    setPkg(null);
    setPlans([]);
    if (!/\.(apkg|colpkg)$/i.test(file.name)) {
      setError(text(t.badFile));
      return;
    }
    setStage("parsing");
    try {
      const parsed = await parseApkg(await file.arrayBuffer(), loadSql);
      if (!parsed.decks.length) throw new ApkgError(text(t.noNotes));
      const known = lists ?? (await loadLists());
      setPkg(parsed);
      setPlans(parsed.decks.map((d) => planFor(parsed, d, known)));
      setStage("ready");
    } catch (e) {
      setError(e instanceof ApkgError ? `${text(t.badFile)} (${e.message})` : (e as Error).message);
      setStage("idle");
    }
  };

  const update = (i: number, patch: Partial<Plan>) =>
    setPlans((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const imported = useMemo(
    () => (lists ?? []).filter((l) => l.source?.startsWith("anki:")),
    [lists],
  );
  const langName = useMemo(() => {
    try {
      const names = new Intl.DisplayNames([locale], { type: "language" });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [locale]);

  const run = async (plan: Plan, built: BuildResult) => {
    setBusy(plan.deck.id);
    setError(null);
    try {
      const r = await fetch("/api/words/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listId: plan.target || undefined,
          deckId: plan.deck.id,
          name: plan.name.trim() || plan.deck.name,
          lang: plan.lang,
          entries: built.entries,
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? r.statusText);
      setOutcomes((o) => ({ ...o, [plan.deck.id]: body as Outcome }));
      // Refresh this device's copy of the list's words, so /words opens with them.
      await downloadCatalog(`/api/words/lists/${body.listId}/entries`).catch(() => {});
      // Importing again now updates the list just made.
      await loadLists();
      setPlans((ps) =>
        ps.map((p) => (p.deck.id === plan.deck.id ? { ...p, target: body.listId } : p)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const roleLabel: Record<Role, unknown> = {
    term: t.roleTerm,
    back: t.roleBack,
    reading: t.roleReading,
    ex: t.roleEx,
    exTr: t.roleExTr,
  };
  const box = "rounded-lg bg-black/5 dark:bg-white/5 p-4";
  const control =
    "rounded bg-black/10 dark:bg-white/10 px-2 py-1 text-sm min-w-0 max-w-full focus:outline focus:outline-2 focus:outline-emerald-500";

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8 space-y-6">
      <div>
        <a href={appHref("/words", locale)} className="text-sm opacity-70 hover:opacity-100">
          {t.backToLists}
        </a>
        <h1 className="text-2xl font-semibold mt-2">{t.title}</h1>
        <p className="opacity-70 text-sm mt-1">{t.intro}</p>
        <a
          href="https://ankiweb.net/shared/decks"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm underline mt-2"
        >
          {t.sharedDecks} ↗
        </a>
      </div>

      {signedOut ? (
        <p className={box}>
          <a href={appHref("/sign-in", locale)} className="underline">
            {t.signIn}
          </a>
        </p>
      ) : (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void open(f);
          }}
          data-testid="apkg-drop"
          className={`block cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragging
              ? "border-emerald-500 bg-emerald-500/10"
              : "border-black/20 dark:border-white/20 hover:border-black/40 dark:hover:border-white/40"
          }`}
        >
          <Icon name="uploadSimple" className="text-3xl opacity-60" />
          <span className="block mt-2 font-medium">
            {stage === "parsing" ? t.parsing : t.dropzone}
          </span>
          <span className="block text-xs opacity-60 mt-1">
            {fill(t.dropHint, { max: MAX_ENTRIES.toLocaleString(locale) })}
          </span>
          <input
            ref={input}
            type="file"
            accept=".apkg,.colpkg"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
              e.target.value = "";
            }}
          />
        </label>
      )}

      {error && (
        <p
          role="alert"
          className="rounded bg-red-500/15 text-red-700 dark:text-red-300 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      {pkg &&
        plans.map((plan, i) => (
          <DeckCard
            key={plan.deck.id}
            pkg={pkg}
            plan={plan}
            imported={imported}
            busy={busy === plan.deck.id}
            outcome={outcomes[plan.deck.id]}
            onChange={(patch) => update(i, patch)}
            onImport={(built) => run(plan, built)}
            langName={langName}
            roleLabel={roleLabel}
            box={box}
            control={control}
          />
        ))}
    </div>
  );
}

function DeckCard({
  pkg,
  plan,
  imported,
  busy,
  outcome,
  onChange,
  onImport,
  langName,
  roleLabel,
  box,
  control,
}: {
  pkg: ApkgPackage;
  plan: Plan;
  imported: WordList[];
  busy: boolean;
  outcome?: Outcome;
  onChange: (patch: Partial<Plan>) => void;
  onImport: (built: BuildResult) => void;
  langName: (code: string) => string;
  roleLabel: Record<Role, unknown>;
  box: string;
  control: string;
}) {
  const t = useIntlayer("words-import");
  const { locale } = useLocale();
  const built = useMemo(() => build(pkg, plan), [pkg, plan]);
  const n = (x: number) => x.toLocaleString(locale);
  const target = imported.find((l) => l.id === plan.target);
  const langs = IMPORT_LANGS.includes(plan.lang as (typeof IMPORT_LANGS)[number])
    ? IMPORT_LANGS
    : [plan.lang, ...IMPORT_LANGS];

  return (
    <section className={`${box} space-y-4`} data-testid="apkg-deck">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold break-all">{plan.deck.name}</h2>
        <span className="text-sm opacity-60 tabular-nums">
          {fill(t.notes, { n: n(plan.deck.notes.length) })} ·{" "}
          {fill(t.words, { n: n(built.entries.length) })}
        </span>
      </div>

      {built.images > 0 && (
        <div
          role="note"
          data-testid="apkg-images"
          className="rounded bg-amber-500/15 text-amber-900 dark:text-amber-200 px-3 py-2 text-sm space-y-1"
        >
          <p className="font-medium">{fill(t.imagesWarning, { n: n(built.images) })}</p>
          <p>
            {t.imagesAdvice}{" "}
            <a href={appHref("/import", locale)} className="underline font-medium">
              {t.importAsCards} →
            </a>
          </p>
        </div>
      )}
      {built.sounds > 0 && <p className="text-xs opacity-70">{t.soundNote}</p>}
      {(built.empty > 0 || built.duplicates > 0 || built.over > 0) && (
        <ul className="text-xs opacity-70 list-disc ps-5">
          {built.empty > 0 && <li>{fill(t.skippedEmpty, { n: n(built.empty) })}</li>}
          {built.duplicates > 0 && <li>{fill(t.duplicates, { n: n(built.duplicates) })}</li>}
          {built.over > 0 && <li>{fill(t.tooMany, { n: n(built.over), max: n(MAX_ENTRIES) })}</li>}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">{t.listName}</span>
          <input
            className={control}
            value={plan.name}
            maxLength={120}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">{t.language}</span>
          <select
            className={control}
            value={plan.lang}
            onChange={(e) => onChange({ lang: e.target.value })}
          >
            {langs.map((l) => (
              <option key={l} value={l}>
                {langName(l)} ({l})
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium opacity-80 mb-1">{t.fields}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 opacity-70">{text(roleLabel[role])}</span>
              <select
                className={`${control} flex-1`}
                data-role={role}
                value={plan.mapping[role]}
                onChange={(e) =>
                  onChange({ mapping: { ...plan.mapping, [role]: Number(e.target.value) } })
                }
              >
                {role !== "term" && <option value={-1}>{t.none}</option>}
                {plan.fields.map((f, i) => (
                  <option key={i} value={i}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </fieldset>

      {built.entries.length > 0 && (
        <div>
          <h3 className="text-sm font-medium opacity-80 mb-1">{t.preview}</h3>
          <ul
            className="text-sm divide-y divide-black/10 dark:divide-white/10"
            data-testid="apkg-preview"
          >
            {built.entries.slice(0, 5).map((e) => (
              <li key={e.key} className="py-1.5 flex flex-wrap gap-x-3">
                <span className="font-medium">{e.term}</span>
                {e.reading && <span className="opacity-60">{e.reading}</span>}
                <span className="opacity-80 min-w-0 break-words">{e.back}</span>
                {e.ex && <span className="basis-full text-xs opacity-60">{e.ex}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">{t.target}</span>
          <select
            className={control}
            value={plan.target}
            onChange={(e) => onChange({ target: e.target.value })}
          >
            <option value="">{t.newList}</option>
            {imported.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || built.entries.length === 0}
          onClick={() => onImport(built)}
          className="px-4 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? t.importing : t.importButton}
        </button>
      </div>
      {target && <p className="text-xs opacity-70">{fill(t.updates, { name: target.name })}</p>}

      {outcome && (
        <p className="text-sm flex flex-wrap items-center gap-3" data-testid="apkg-done">
          <span>
            ✓{" "}
            {fill(t.done, {
              added: n(outcome.added),
              updated: n(outcome.updated),
              unchanged: n(outcome.unchanged),
            })}
          </span>
          <a
            href={appHref(`/words?list=${outcome.listId}`, locale)}
            className="px-3 py-1 rounded bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/20"
          >
            {t.openList} →
          </a>
        </p>
      )}
    </section>
  );
}
