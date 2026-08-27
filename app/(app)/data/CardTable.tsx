"use client";

import { useState } from "react";
import { CARD_STATES, dueLabel, stateName, type DataRow, type StoreId } from "./types";

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

  page: number;
  size: number;
  onPageChange: (page: number) => void;

  selected: Set<string>;
  onSelectedChange: (selected: Set<string>) => void;
  onDeleteSelected: () => void;
  deleting: boolean;

  editable: boolean;
  onRename: (url: string, title: string) => Promise<void>;
  deleteSelectedLabel: string;
};

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: "title", label: "Title", sortable: true },
  { key: "state", label: "State", sortable: true },
  { key: "due", label: "Due", sortable: true },
  { key: "reps", label: "Reps", sortable: true },
  { key: "lapses", label: "Lapses", sortable: true },
  { key: "stores", label: "In", sortable: false },
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
    page,
    size,
    onPageChange,
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

  const pageCount = Math.max(1, Math.ceil(total / size));
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

  return (
    <section aria-labelledby="cards-heading">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h2 id="cards-heading" className="text-xl font-semibold">
          {heading}
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="store-select" className="text-gray-500 dark:text-gray-400">
            Store
          </label>
          <select
            id="store-select"
            value={store}
            onChange={(e) => onStoreChange(e.target.value as StoreId)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
          >
            <option value="cloud" disabled={!cloudAvailable}>
              ☁️ Cloud{cloudAvailable ? "" : " (sign in)"}
            </option>
            <option value="local">🗂️ Local</option>
          </select>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
        <input
          type="search"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder="Search title or URL…"
          aria-label="Search cards"
          className="flex-1 min-w-[12rem] rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-3 py-1.5"
        />
        <select
          value={state ?? ""}
          onChange={(e) => onStateChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-label="Filter by state"
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5"
        >
          <option value="">All states</option>
          {CARD_STATES.map((name, value) => (
            <option key={name} value={value}>
              {name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={onlyDue}
            onChange={(e) => onOnlyDueChange(e.target.checked)}
          />
          Due only
        </label>
        <span className="ms-auto text-gray-500 dark:text-gray-400 font-mono">
          {total === 0 ? "0" : `${page * size + 1}–${Math.min(total, (page + 1) * size)}`} / {total}
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th scope="col" className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  aria-label="Select all rows on this page"
                />
              </th>
              {COLUMNS.map((col) => (
                <th key={col.key} scope="col" className="px-3 py-2 text-start font-semibold">
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(col.key)}
                      className="inline-flex items-center gap-1 hover:underline"
                      aria-label={`Sort by ${col.label}`}
                    >
                      {col.label}
                      {sort === col.key && <span aria-hidden>{order === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
              {editable && <th scope="col" className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  No cards match these filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.url}
                  className="border-t border-gray-100 dark:border-gray-800 align-top"
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row.url)}
                      onChange={() => toggle(row.url)}
                      aria-label={`Select ${row.title}`}
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
                          aria-label="Card title"
                          className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
                        />
                        <button type="submit" className="text-blue-600 hover:underline">
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="text-gray-500 hover:underline"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="truncate font-medium">{row.title}</div>
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
                    <span title="Local (IndexedDB)">{row.inLocal ? "L" : "·"}</span>
                    <span title="Cloud">{row.inCloud ? "C" : "·"}</span>
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
                        Rename
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between flex-wrap gap-3 text-sm">
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={selected.size === 0 || deleting}
          className="rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? "Deleting…" : `${deleteSelectedLabel} (${selected.size})`}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
            className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 disabled:opacity-40"
          >
            ‹
          </button>
          <span className="font-mono">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page + 1 >= pageCount}
            className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>
    </section>
  );
}
