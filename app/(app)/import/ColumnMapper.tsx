"use client";

/**
 * The column-mapping step of the word-list import (lib/import/column-map.ts):
 * each file column is a chip, dragged onto the field it fills (word, meaning,
 * example, reading, example translation) or onto Ignore; chips in one field
 * are read in their order and can be reordered. dnd-kit: mouse, touch (a
 * short hold, so the page still scrolls under a finger) and keyboard (Space
 * picks a chip up, arrows move it, Space drops it, Escape cancels), with
 * spoken announcements.
 *
 * Under it, the first rows as the /words cards they will become, updated as
 * the chips move (CardPreview).
 */
import { useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ignored,
  moveColumn,
  SLOTS,
  slotOf,
  type ColumnMapping,
  type Slot,
} from "@/lib/import/column-map";
import type { WordRow } from "@/lib/import/wordlist";
import { backParts } from "@/lib/words/row-layout";

const text = (s: unknown): string =>
  typeof s === "string" ? s : String((s as { value?: unknown } | null)?.value ?? s);
const fill = (s: unknown, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text(s));

/** A drop target: a field, or the ignore pile. */
type Box = Slot | "ignore";
const BOXES: readonly Box[] = [...SLOTS, "ignore"];
const boxId = (b: Box) => `box:${b}`;
const chipId = (col: number) => `col:${col}`;
const colOf = (id: UniqueIdentifier) =>
  String(id).startsWith("col:") ? Number(String(id).slice(4)) : null;
const boxOf = (id: UniqueIdentifier): Box | null => {
  const s = String(id);
  return s.startsWith("box:") ? (s.slice(4) as Box) : null;
};

export function ColumnMapper({
  names,
  samples,
  width,
  mapping,
  onChange,
}: {
  /** The header's cells; null when the file has no header row. */
  names: string[] | null;
  /** Each column's first value, shown on its chip. */
  samples: string[];
  width: number;
  mapping: ColumnMapping;
  onChange: (m: ColumnMapping) => void;
}) {
  const t = useIntlayer("import-wordlist");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // A short hold: a finger that just scrolls the page never picks a chip up.
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [active, setActive] = useState<number | null>(null);
  const label = (col: number) => names?.[col]?.trim() || fill(t.columnN, { n: col + 1 });
  const boxName = (b: Box): string =>
    text(
      b === "term"
        ? t.colWord
        : b === "back"
          ? t.colMeaning
          : b === "ex"
            ? t.colExample
            : b === "reading"
              ? t.slotReading
              : b === "exTr"
                ? t.slotExTr
                : t.slotIgnore,
    );
  const cols = (b: Box) => (b === "ignore" ? ignored(mapping, width) : mapping[b]);
  /** Which box an id (a chip or a box) is in. */
  const where = (id: UniqueIdentifier): Box | null => {
    const b = boxOf(id);
    if (b) return b;
    const c = colOf(id);
    return c === null ? null : (slotOf(mapping, c) ?? "ignore");
  };
  const toward = (over: UniqueIdentifier): { box: Box; index?: number } | null => {
    const box = where(over);
    if (!box) return null;
    const c = colOf(over);
    return { box, index: c === null || box === "ignore" ? undefined : mapping[box].indexOf(c) };
  };
  const move = (col: number, to: { box: Box; index?: number }) =>
    onChange(moveColumn(mapping, col, to.box === "ignore" ? null : to.box, to.index));

  const onDragStart = (e: DragStartEvent) => setActive(colOf(e.active.id));
  // Across boxes while dragging, so the chip shows where it will land.
  const onDragOver = (e: DragOverEvent) => {
    const col = colOf(e.active.id);
    if (col === null || !e.over) return;
    const from = where(e.active.id);
    const to = toward(e.over.id);
    if (to && to.box !== from) move(col, to);
  };
  // Within a box: the new order.
  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const col = colOf(e.active.id);
    if (col === null || !e.over) return;
    const to = toward(e.over.id);
    if (!to) return;
    const from = where(e.active.id);
    if (to.box === from && to.box !== "ignore" && to.index !== undefined) move(col, to);
    else if (to.box !== from) move(col, to);
  };

  const say = (id: UniqueIdentifier) => {
    const c = colOf(id);
    return c === null ? "" : label(c);
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => fill(t.dndPicked, { column: say(a.id) }),
    onDragOver: ({ active: a, over }) =>
      over
        ? fill(t.dndOver, { column: say(a.id), field: boxName(where(over.id) ?? "ignore") })
        : "",
    onDragEnd: ({ active: a, over }) =>
      over
        ? fill(t.dndDropped, { column: say(a.id), field: boxName(where(over.id) ?? "ignore") })
        : fill(t.dndCancelled, { column: say(a.id) }),
    onDragCancel: ({ active: a }) => fill(t.dndCancelled, { column: say(a.id) }),
  };

  return (
    <div data-qa="wordlist-mapper" className="mt-4">
      <p className="text-sm font-medium">{t.mapHeading}</p>
      <p className="mt-0.5 text-xs text-[oklch(0.4_0_0)] dark:text-[oklch(0.82_0_0)]">
        {t.mapHint}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: text(t.dndInstructions) },
        }}
      >
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {BOXES.map((b) => (
            <Field key={b} box={b} name={boxName(b)} need={b === "term" && !mapping.term.length}>
              <SortableContext items={cols(b).map(chipId)} strategy={verticalListSortingStrategy}>
                {cols(b).map((c) => (
                  <Chip key={c} col={c} name={label(c)} sample={samples[c] ?? ""} />
                ))}
              </SortableContext>
            </Field>
          ))}
        </div>
        <DragOverlay>
          {active !== null ? (
            <ChipFace name={label(active)} sample={samples[active] ?? ""} lifted />
          ) : null}
        </DragOverlay>
      </DndContext>
      {!mapping.term.length && (
        <p role="alert" data-qa="wordlist-need-word" className="mt-2 text-sm">
          <span aria-hidden>⚠︎ </span>
          {t.needWord}
        </p>
      )}
    </div>
  );
}

function Field({
  box,
  name,
  need,
  children,
}: {
  box: Box;
  name: string;
  need: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: boxId(box) });
  return (
    <div
      ref={setNodeRef}
      data-qa={`wordlist-slot-${box}`}
      role="group"
      aria-label={name}
      className={`min-h-16 rounded-xl border p-2 transition-colors ${
        isOver
          ? "border-[var(--brand)] bg-[oklch(from_var(--brand)_l_c_h/0.08)]"
          : need
            ? "border-dashed border-[var(--brand)]"
            : box === "ignore"
              ? "border-dashed border-[oklch(0.6_0_0/0.5)]"
              : "border-[oklch(0.6_0_0/0.4)]"
      }`}
    >
      <p
        className={`mb-1 text-xs font-medium ${box === "ignore" ? "text-[oklch(0.45_0_0)] dark:text-[oklch(0.78_0_0)]" : ""}`}
      >
        {name}
      </p>
      <div className="flex min-h-11 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ col, name, sample }: { col: number; name: string; sample: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chipId(col),
  });
  return (
    <div
      ref={setNodeRef}
      data-qa="wordlist-chip"
      data-col={col}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        // Taken by dnd-kit only after a short hold (TouchSensor); the page scrolls before that.
        touchAction: "manipulation",
        visibility: isDragging ? "hidden" : undefined,
      }}
      {...attributes}
      {...listeners}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    >
      <ChipFace name={name} sample={sample} />
    </div>
  );
}

function ChipFace({
  name,
  sample,
  lifted = false,
}: {
  name: string;
  sample: string;
  lifted?: boolean;
}) {
  return (
    <div
      className={`flex min-h-11 cursor-grab select-none items-center gap-2 rounded-lg border border-[oklch(0.6_0_0/0.45)] bg-[oklch(0.99_0_0)] px-3 py-1.5 text-sm dark:bg-[oklch(0.26_0_0)] ${
        lifted ? "cursor-grabbing shadow-lg" : ""
      }`}
    >
      <span aria-hidden className="opacity-60">
        ⠿
      </span>
      <span className="font-medium">{name}</span>
      {sample && (
        <span className="min-w-0 truncate text-xs text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]">
          {sample}
        </span>
      )}
    </div>
  );
}

/**
 * The first rows as /words cards: the word (and its reading), then the back
 * in the cards' own order (BACK_ORDER: example, then meaning), on the slip's
 * paper. Shown open, as after a tap.
 */
export function CardPreview({ rows, lang }: { rows: WordRow[]; lang?: string }) {
  const t = useIntlayer("import-wordlist");
  const shown = useMemo(() => rows.slice(0, 4), [rows]);
  if (!shown.length) return null;
  return (
    <div className="mt-4" data-qa="wordlist-cards">
      <p className="text-sm font-medium">{t.cardsHeading}</p>
      <div role="list" className="lk-fs-cards mt-2 overflow-hidden rounded-xl">
        {shown.map((r) => (
          <div
            key={r.line}
            role="listitem"
            data-qa="wordlist-card"
            // The study list's binding line sits at its own column width; not here.
            style={{ "--slip-node": "transparent" } as React.CSSProperties}
            className="slip grid min-h-[66px] grid-cols-[minmax(4rem,8rem)_1fr] items-center gap-3 px-3 py-2"
          >
            <span className="min-w-0 break-words font-medium" lang={lang}>
              {r.term}
              {r.reading && r.reading !== r.term && (
                <span className="ml-2 text-xs font-normal opacity-70">{r.reading}</span>
              )}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              {backParts(r).map((part, i) =>
                part === "example" ? (
                  <span key={part} data-qa="wordlist-card-example" className="text-sm opacity-85">
                    <bdi lang={lang}>{r.ex}</bdi>
                    {r.exTr && <span className="ml-2 text-xs opacity-80">{r.exTr}</span>}
                  </span>
                ) : (
                  <span
                    key={part}
                    data-qa="wordlist-card-meaning"
                    className={i === 0 ? "text-sm opacity-85" : "text-xs opacity-80"}
                  >
                    {r.back}
                  </span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
