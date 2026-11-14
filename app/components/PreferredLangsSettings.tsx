"use client";

// Settings → Preferred languages (lib/lang-order.ts): the ordered list that
// /words, /alphabet and /books put first. Reorder by dragging (dnd-kit, with
// its keyboard sensor) or the ↑ ↓ buttons, add from a menu, remove with ×.
// Stored as `lk:lang-preferred`, synced as `lang.preferred`
// (docs/prefs-sync.md). While nothing is picked, the list is automatic.
// Each row also carries how well the user knows the language
// (lib/lang-levels.ts): every level shown at once, the active one in the
// theme red (owner rule: a switch shows all its states).

import { useMemo } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "./icons";
import { canonicalLang, LANG_CHOICES, langMatch } from "@/lib/lang-order";
import { LANG_LEVELS, levelCode, type LangLevel } from "@/lib/lang-levels";
import { usePreferredLangs } from "@/lib/use-preferred-langs";

const put = (s: string, lang: string) => s.replace("{lang}", lang);

/** A language's name in `locale` ("ja" → "Japanese" / "日语"), the tag itself when unknown. */
function nameIn(tag: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The level picker of one row: every level visible, the active one filled in seal red. */
function LevelPicker({
  tag,
  name,
  level,
  onLevel,
}: {
  tag: string;
  name: string;
  level: LangLevel;
  onLevel: (level: LangLevel) => void;
}) {
  const c = useIntlayer("preferred-langs");
  return (
    <div
      role="radiogroup"
      aria-label={put(c.levelPick.value, name)}
      data-pref-lang-levels={tag}
      className="flex flex-wrap gap-1 ps-3 pe-1 pb-2 sm:ps-16"
    >
      {LANG_LEVELS.map((l) => {
        const on = l.id === level;
        const label = l.label ? c[l.label].value : levelCode(l.id);
        return (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-level={l.id}
            onClick={() => !on && onLevel(l.id)}
            className={`h-8 min-w-9 rounded-full border px-2.5 text-xs font-medium ${
              on
                ? "border-seal bg-seal text-[oklch(0.99_0_0)] dark:border-[oklch(0.75_0.15_22.3)] dark:bg-[oklch(0.75_0.15_22.3)] dark:text-[oklch(0.2_0.02_22.3)]"
                : "border-[oklch(0.5_0.02_250/0.4)] opacity-80 hover:bg-[oklch(0.5_0_0/0.1)] hover:opacity-100"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  tag,
  index,
  count,
  locale,
  level,
  onMove,
  onRemove,
  onLevel,
}: {
  tag: string;
  index: number;
  count: number;
  locale: string;
  level: LangLevel;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  onLevel: (level: LangLevel) => void;
}) {
  const c = useIntlayer("preferred-langs");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tag });
  const name = nameIn(tag, locale);
  const own = nameIn(tag, tag);
  const btn =
    "grid h-11 w-10 shrink-0 place-items-center rounded-full opacity-70 hover:bg-[oklch(0.5_0_0/0.12)] hover:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition }}
      data-pref-lang={tag}
      data-pref-lang-level={level}
      className={`rounded-lg ${
        isDragging
          ? "relative z-10 bg-[oklch(0.5_0_0/0.14)] shadow-lg ring-1 ring-[oklch(0.5_0_0/0.35)]"
          : "bg-[oklch(0.5_0_0/0.06)] dark:bg-[oklch(0.8_0_0/0.06)]"
      }`}
    >
      <div className="flex min-h-12 items-center gap-1 pe-1">
        <span
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={put(c.drag.value, name)}
          className="grid h-11 w-9 shrink-0 cursor-grab touch-none select-none place-items-center text-lg leading-none opacity-50 hover:opacity-100 active:cursor-grabbing"
        >
          ⠿
        </span>
        <span className="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-seal dark:text-[oklch(0.75_0.15_22.3)]">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 py-1 leading-tight">
          <span className="block truncate">{name}</span>
          <span className="block truncate text-xs opacity-70">
            {own !== name && own !== tag && (
              <span lang={tag} className="me-2">
                {own}
              </span>
            )}
            <span className="font-mono">{tag}</span>
          </span>
        </span>
        <button
          type="button"
          className={btn}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
          aria-label={put(c.moveUp.value, name)}
          title={put(c.moveUp.value, name)}
        >
          ↑
        </button>
        <button
          type="button"
          className={btn}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
          aria-label={put(c.moveDown.value, name)}
          title={put(c.moveDown.value, name)}
        >
          ↓
        </button>
        <button
          type="button"
          className={btn}
          onClick={onRemove}
          aria-label={put(c.remove.value, name)}
          title={put(c.remove.value, name)}
          data-pref-lang-remove={tag}
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>
      <LevelPicker tag={tag} name={name} level={level} onLevel={onLevel} />
    </li>
  );
}

export function PreferredLangsSettings({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  const c = useIntlayer("preferred-langs");
  const { locale } = useLocale();
  const ui = String(locale ?? "en");
  const { langs, automatic, set, reset, levelOf, setLevel } = usePreferredLangs();
  const list = langs ?? [];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // The menu: common languages not already covered by an exact pick, by name.
  const choices = useMemo(
    () =>
      LANG_CHOICES.filter((t) => !list.some((p) => langMatch(p, t) === 2))
        .map((t) => [t, nameIn(t, ui)] as const)
        .sort((a, b) => a[1].localeCompare(b[1], ui)),
    [list, ui],
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    set(arrayMove(list, from, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(list.indexOf(String(active.id)), list.indexOf(String(over.id)));
  };

  return (
    <section
      id="preferred-langs"
      className="mb-10 max-w-xl scroll-mt-6"
      data-section="preferred-langs"
      data-testid="preferred-langs"
    >
      {!hideHeading && <h2 className="mb-2 text-2xl font-semibold">{c.heading.value}</h2>}
      <p className="mb-3 text-sm text-[oklch(0.42_0.02_250)] dark:text-[oklch(0.78_0.02_250)]">
        {c.help.value}
      </p>
      <p className="mb-3 text-sm text-[oklch(0.42_0.02_250)] dark:text-[oklch(0.78_0.02_250)]">
        {c.levelHelp.value}
      </p>
      {langs && automatic && list.length > 0 && (
        <p
          className="mb-3 text-xs text-[oklch(0.42_0.02_250)] dark:text-[oklch(0.78_0.02_250)]"
          data-testid="preferred-langs-auto"
        >
          {c.automatic.value}
        </p>
      )}
      {langs && list.length === 0 && <p className="mb-3 text-sm opacity-80">{c.empty.value}</p>}
      {list.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list} strategy={verticalListSortingStrategy}>
            <ol className="space-y-1.5" data-testid="preferred-langs-list">
              {list.map((tag, i) => (
                <Row
                  key={tag}
                  tag={tag}
                  index={i}
                  count={list.length}
                  locale={ui}
                  onMove={move}
                  level={levelOf(tag)}
                  onRemove={() => set(list.filter((t) => t !== tag))}
                  onLevel={(lv) => setLevel(tag, lv)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {list.length > 1 && (
        <p className="mt-2 text-xs text-[oklch(0.42_0.02_250)] dark:text-[oklch(0.78_0.02_250)]">
          {c.dragHelp.value}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value=""
          aria-label={c.add.value}
          data-testid="preferred-langs-add"
          onChange={(e) => {
            const tag = canonicalLang(e.target.value);
            if (tag) set([...list, tag]);
          }}
          className="h-11 min-w-0 max-w-full rounded-lg border border-[oklch(0.5_0.02_250/0.4)] bg-transparent px-3 dark:bg-[oklch(0.2_0.01_250)]"
        >
          <option value="">{c.add.value}</option>
          {choices.map(([t, name]) => (
            <option key={t} value={t}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={reset}
          disabled={!langs || automatic}
          data-testid="preferred-langs-reset"
          className="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-seal hover:bg-[oklch(0.53_0.207_22.3/0.1)] disabled:text-current disabled:opacity-40 disabled:hover:bg-transparent dark:text-[oklch(0.75_0.15_22.3)]"
        >
          <Icon name="reset" className="h-5 w-5" />
          {c.reset.value}
        </button>
      </div>
    </section>
  );
}
