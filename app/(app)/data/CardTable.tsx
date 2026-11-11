"use client";

import { useState } from "react";
import { displayTitle } from "@/lib/titles/client";
import { VirtualList } from "@/app/components/VirtualList";
import { SealSwitch } from "@/app/components/SealSwitch";
import { useIntlayer } from "next-intlayer";
import { fill } from "@/lib/roadmap/labels";
import { CARD_STATES, dueLabel, type DataRow, type StoreId } from "./types";

type Props = {
  heading: string;
  store: StoreId;
  onStoreChange: (store: StoreId) => void;
  cloudAvailable: boolean;

  rows: DataRow[];
  total: number;
  loading: boolean;
  error: string | null;

  q: string;
  onQChange: (q: string) => void;
  state: number | null;
  onStateChange: (state: number | null) => void;
  onlyDue: boolean;
  onOnlyDueChange: (onlyDue: boolean) => void;

  sort: string;
  order: "asc" | "desc";
  onSortChange: (sort: string) => void;

  /** More rows on the server (cloud); the table asks as its end nears. */
  hasMore: boolean;
  /** The last batch failed: the table offers Try again. */
  listError: boolean;
  onReachEnd: () => void;

  selected: Set<string>;
  onSelectedChange: (selected: Set<string>) => void;
  onDeleteSelected: () => void;
  deleting: boolean;

  editable: boolean;
  onRename: (url: string, title: string) => Promise<void>;
  deleteSelectedLabel: string;
};

type ColKey = "colTitle" | "colState" | "colDue" | "colReps" | "colLapses" | "colIn";
const COLUMNS: { key: string; label: ColKey; sortable: boolean }[] = [
  { key: "title", label: "colTitle", sortable: true },
  { key: "state", label: "colState", sortable: true },
  { key: "due", label: "colDue", sortable: true },
  { key: "reps", label: "colReps", sortable: true },
  { key: "lapses", label: "colLapses", sortable: true },
  { key: "stores", label: "colIn", sortable: false },
];

export default function CardTable(props: Props) {
  const {
    heading,
    store,
    onStoreChange,
    cloudAvailable,
    rows,
    total,
    loading,
    error,
    q,
    onQChange,
    state,
    onStateChange,
    onlyDue,
    onOnlyDueChange,
    sort,
    order,
    onSortChange,
    hasMore,
    listError,
    onReachEnd,
    selected,
    onSelectedChange,
    onDeleteSelected,
    deleting,
    editable,
    onRename,
    deleteSelectedLabel,
  } = props;

  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.url));

  function toggle(url: string) {
    const next = new Set(selected);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    onSelectedChange(next);
  }

  function toggleAll() {
    const next = new Set(selected);
    if (allOnPageSelected) rows.forEach((r) => next.delete(r.url));
    else rows.forEach((r) => next.add(r.url));
    onSelectedChange(next);
  }

  const tt = useIntlayer("data-page").table;
  // Column names and card states, as the dictionary words them.
  const colName = (k: ColKey) => tt[k].value;
  const STATE_KEYS = ["stateNew", "stateLearning", "stateReview", "stateRelearning"] as const;
  const stateName = (s: number) => (STATE_KEYS[s] ? tt[STATE_KEYS[s]].value : String(s));

  return (
    <section aria-labelledby="cards-heading">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h2 id="cards-heading" className="text-xl font-semibold">
          {heading}
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="store-select" className="text-gray-500 dark:text-gray-400">
            {tt.store}
          </label>
          <select
            id="store-select"
            value={store}
            onChange={(e) => onStoreChange(e.target.value as StoreId)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
          >
            <option value="cloud" disabled={!cloudAvailable}>
              {cloudAvailable ? tt.storeCloud.value : tt.storeCloudSignIn.value}
            </option>
            <option value="local">{tt.storeLocal.value}</option>
          </select>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <input
          type="search"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder={tt.search.value}
          aria-label={tt.searchLabel.value}
          className="flex-1 min-w-[12rem] rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-3 py-1.5"
        />
        <select
          value={state ?? ""}
          onChange={(e) => onStateChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={tt.filterState.value}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5"
        >
          <option value="">{tt.allStates.value}</option>
          {CARD_STATES.map((name, value) => (
            <option key={name} value={value}>
              {stateName(value)}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-2">
          <span id="cards-due-only-label">{tt.dueOnly}</span>
          <SealSwitch
            size="sm"
            checked={onlyDue}
            aria-labelledby="cards-due-only-label"
            onClick={() => onOnlyDueChange(!onlyDue)}
          />
        </span>
        <span
          className="ms-auto text-gray-500 dark:text-gray-400 font-mono"
          data-testid="cards-total"
        >
          {total}
        </span>
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={selected.size === 0 || deleting}
          className="rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? tt.deleting : `${deleteSelectedLabel} (${selected.size})`}
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <VirtualList
        items={rows}
        getKey={(row) => row.url}
        name={`data-${store}`}
        hasMore={hasMore}
        loading={loading}
        error={listError}
        onReachEnd={onReachEnd}
        estimateSize={52}
        className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700"
        rowClassName="border-t border-gray-100 dark:border-gray-800 align-top"
        empty={
          <p className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-8 text-center text-sm text-gray-500">
            {tt.empty}
          </p>
        }
        table={{
          className: "w-full text-sm",
          label: heading,
          head: (
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th scope="col" className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAll}
                    aria-label={tt.selectAll.value}
                  />
                </th>
                {COLUMNS.map((col) => (
                  <th key={col.key} scope="col" className="px-3 py-2 text-start font-semibold">
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(col.key)}
                        className="inline-flex items-center gap-1 hover:underline"
                        aria-label={fill(tt.sortBy.value, { column: colName(col.label) })}
                      >
                        {colName(col.label)}
                        {sort === col.key && <span aria-hidden>{order === "asc" ? "▲" : "▼"}</span>}
                      </button>
                    ) : (
                      colName(col.label)
                    )}
                  </th>
                ))}
                {editable && <th scope="col" className="px-3 py-2" />}
              </tr>
            </thead>
          ),
        }}
        renderItem={(row) => (
          <>
            <td className="px-3 py-2">
              <input
                type="checkbox"
                checked={selected.has(row.url)}
                onChange={() => toggle(row.url)}
                aria-label={fill(tt.select.value, { title: row.title })}
              />
            </td>
            <td className="px-3 py-2 max-w-md">
              {editing === row.url ? (
                <form
                  className="flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await onRename(row.url, draftTitle);
                    setEditing(null);
                  }}
                >
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    aria-label={tt.cardTitle.value}
                    className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
                  />
                  <button type="submit" className="text-blue-600 hover:underline">
                    {tt.save}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-gray-500 hover:underline"
                  >
                    {tt.cancel}
                  </button>
                </form>
              ) : (
                <>
                  <div className="truncate font-medium">{displayTitle(row.title, row.url)}</div>
                  <a
                    href={row.url}
                    className="block truncate text-xs text-gray-500 dark:text-gray-400 hover:underline"
                  >
                    {row.url}
                  </a>
                </>
              )}
            </td>
            <td className="px-3 py-2 whitespace-nowrap">{stateName(row.state)}</td>
            <td className="px-3 py-2 whitespace-nowrap font-mono">{dueLabel(row.due)}</td>
            <td className="px-3 py-2 font-mono">{row.reps}</td>
            <td className="px-3 py-2 font-mono">{row.lapses}</td>
            <td className="px-3 py-2 font-mono whitespace-nowrap">
              <span title={tt.inLocal.value} aria-label={tt.inLocal.value} hidden={!row.inLocal}>
                💻
              </span>
              {!row.inLocal && <span aria-hidden>·</span>}
              <span title={tt.inCloud.value} aria-label={tt.inCloud.value} hidden={!row.inCloud}>
                ☁️
              </span>
              {!row.inCloud && <span aria-hidden>·</span>}
            </td>
            {editable && (
              <td className="px-3 py-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(row.url);
                    setDraftTitle(row.title);
                  }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {tt.rename}
                </button>
              </td>
            )}
          </>
        )}
      />
    </section>
  );
}
