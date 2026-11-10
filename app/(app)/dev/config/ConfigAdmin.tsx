"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { CONFIG, type ConfigDef } from "@/lib/config";
import type { ConfigLogEntry, ConfigRow } from "@/lib/config-store";
import { card, Chevron, jst } from "../flags/FlagCard";
import { DevToast, type DevToastMsg } from "../DevToast";
import { Icon } from "@/app/components/icons";
import {
  draftValue,
  fill,
  formatValue,
  groupConfigRows,
  historyOf,
  sameValue,
} from "./config-view";

type State = { rows: ConfigRow[]; log: ConfigLogEntry[]; cacheSeconds: number };

const tag =
  "rounded-full border border-[oklch(0_0_0/0.15)] dark:border-[oklch(1_0_0/0.2)] px-2 py-0.5 text-xs";
const field =
  "min-w-0 rounded-lg border border-[oklch(0_0_0/0.2)] dark:border-[oklch(1_0_0/0.25)] bg-transparent px-2 py-1.5 text-base sm:text-sm";

/** Every registry config key with its value, default, range and history. */
export default function ConfigAdmin() {
  const t = useIntlayer("dev-config");
  const [state, setState] = useState<State | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<DevToastMsg | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/dev/config", { cache: "no-store" });
      if (r.ok) setState(await r.json());
      else setMsg(`HTTP ${r.status}`);
    })();
  }, []);

  const groups = useMemo(() => (state ? groupConfigRows(state.rows) : []), [state]);

  async function send(row: ConfigRow, body: Record<string, unknown>, shown: unknown) {
    const def = CONFIG[row.key] as ConfigDef;
    if (
      def.money &&
      !window.confirm(
        fill(t.moneyConfirm.value, { key: row.key, value: formatValue(shown, def.unit) }),
      )
    )
      return false;
    setBusy(true);
    setToast(null);
    try {
      const r = await fetch("/api/dev/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: row.key,
          ...body,
          ...(def.money ? { confirmMoney: true } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setState(data);
        setToast({
          ok: true,
          id: Date.now(),
          text: fill(t.saved.value, {
            key: row.key,
            value: formatValue(shown, def.unit),
            seconds: data.cacheSeconds ?? state?.cacheSeconds ?? "",
          }),
        });
        return true;
      }
      setToast({
        ok: false,
        id: Date.now(),
        text: fill(t.failed.value, { key: row.key, error: data.error ?? `HTTP ${r.status}` }),
      });
    } catch (e) {
      setToast({
        ok: false,
        id: Date.now(),
        text: fill(t.failed.value, { key: row.key, error: String(e) }),
      });
    } finally {
      setBusy(false);
    }
    return false;
  }

  if (!state) return <p className="text-sm opacity-70">{msg ?? "…"}</p>;
  return (
    <div className="space-y-5">
      <DevToast msg={toast} onClose={closeToast} />
      <p className="text-sm opacity-70">{fill(t.intro.value, { seconds: state.cacheSeconds })}</p>
      {groups.map((g) => (
        <section key={g.id} data-config-group={g.id} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <span className="font-mono">{g.id}</span>
            {g.changed > 0 && (
              <span className="ms-auto text-xs font-normal opacity-70">
                {t.changed} {g.changed} / {g.rows.length}
              </span>
            )}
          </h2>
          {g.rows.map((row) => (
            <ConfigCard
              key={`${row.key}:${String(row.value)}:${row.updatedAt}`}
              row={row}
              log={historyOf(state.log, row.key)}
              busy={busy}
              onSave={(text, note) =>
                send(row, { value: draftValue(row.key, text), note }, draftValue(row.key, text))
              }
              onReset={(note) => send(row, { reset: true, note }, row.default)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ConfigCard({
  row,
  log,
  busy,
  onSave,
  onReset,
}: {
  row: ConfigRow;
  log: ConfigLogEntry[];
  busy: boolean;
  onSave: (text: string, note: string | null) => Promise<boolean>;
  onReset: (note: string | null) => Promise<boolean>;
}) {
  const t = useIntlayer("dev-config");
  const def = CONFIG[row.key] as ConfigDef;
  const [text, setText] = useState(String(row.value));
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const changed = !sameValue(row.value, row.default);
  const dirty = text.trim() !== String(row.value);
  const numeric = typeof row.default === "number";
  const noteOrNull = note.trim() || null;

  return (
    <article id={row.key} data-config-key={row.key} className={`${card} scroll-mt-20`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <code className="text-sm font-bold break-all">{row.key}</code>
        {changed && (
          <span
            data-config-changed
            className="rounded-full bg-primary px-2 py-0.5 text-xs text-on-primary"
          >
            {t.changed}
          </span>
        )}
        <span className={`${tag} ms-auto`}>
          {def.audience === "public" ? t.browser : t.serverOnly}
        </span>
        {def.money && <span className={tag}>{t.money}</span>}
      </div>
      <p lang="zh" className="text-sm opacity-80">
        {def.description}
      </p>
      {row.invalid && (
        <p role="note" className="flex items-start gap-1 text-xs">
          <Icon name="warning" className="mt-0.5 shrink-0" />
          {t.invalid}
        </p>
      )}
      <p className="text-xs opacity-70">
        {fill(t.defaultIs.value, { value: formatValue(row.default, def.unit) })}
        {def.min !== undefined && def.max !== undefined && (
          <> · {fill(t.range.value, { min: def.min, max: def.max })}</>
        )}
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void onSave(text, noteOrNull);
        }}
      >
        <label className="flex items-center gap-1.5">
          <input
            aria-label={t.value.value}
            className={`${field} w-28 font-mono`}
            inputMode={numeric ? "numeric" : undefined}
            type={numeric ? "number" : "text"}
            min={def.min}
            max={def.max}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {def.unit && <span className="text-xs opacity-70">{def.unit}</span>}
        </label>
        <input
          aria-label={t.note.value}
          placeholder={t.note.value}
          className={`${field} flex-1 basis-32`}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !dirty}
          className="min-h-9 rounded-lg bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {t.save}
        </button>
        {row.stored && (
          <button
            type="button"
            data-config-reset
            disabled={busy}
            onClick={() => void onReset(noteOrNull)}
            className="min-h-9 rounded-lg border border-primary px-3 text-sm text-primary dark:border-[oklch(0.7_0.15_22.3)] dark:text-[oklch(0.8_0.12_22.3)] disabled:opacity-40"
          >
            {t.reset}
          </button>
        )}
      </form>
      {log.length > 0 && (
        <div>
          <button
            type="button"
            data-config-history
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-h-9 items-center gap-1 text-xs opacity-80"
          >
            <Chevron open={open} />
            {fill(t.history.value, { count: log.length })}
          </button>
          {open && (
            <ul className="space-y-1 font-mono text-xs">
              {log.map((e, i) => (
                <li key={i}>
                  {jst(e.at)} · {formatValue(e.old, def.unit, t.defaultWord.value)} →{" "}
                  {formatValue(e.new, def.unit, t.defaultWord.value)} · {e.by}
                  {e.note && <span className="opacity-70"> · {e.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
