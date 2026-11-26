"use client";
import { useId, useRef, useState } from "react";
import { cleanTokenName } from "@/lib/api-tokens";

export type RenameLabels = {
  rename: string;
  save: string;
  cancel: string;
  name: string;
  hint: string;
  invalid: string;
  failed: string;
};
/** Inline, session-only name editor; never requests or changes a token's secret or permissions. */
export function TokenRename({
  id,
  name,
  labels,
  onRenamed,
}: {
  id: string;
  name: string;
  labels: RenameLabels;
  onRenamed: (name: string) => void;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    const next = cleanTokenName(draft);
    if (!next) return setError(labels.invalid);
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/token", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: next }),
      });
      const body = await r.json().catch(() => null);
      if (
        !r.ok ||
        body?.ok !== true ||
        body.id !== id ||
        typeof body.name !== "string" ||
        cleanTokenName(body.name) !== body.name
      ) {
        setError(
          typeof body?.error === "string" && body.error.startsWith("name:")
            ? labels.invalid
            : labels.failed,
        );
        return;
      }
      onRenamed(body.name);
      setEditing(false);
    } catch {
      setError(labels.failed);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <button
        type="button"
        className="text-sm text-primary hover:underline"
        onClick={() => {
          setDraft(name);
          setError(null);
          setEditing(true);
        }}
      >
        {labels.rename}
      </button>
    );
  return (
    <form onSubmit={save} className="basis-full min-w-0 space-y-2">
      <label htmlFor={inputId} className="block text-sm">
        {labels.name}
      </label>
      <input
        autoFocus
        id={inputId}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
      />
      <p className="text-xs opacity-70">{labels.hint}</p>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
        >
          {labels.save}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(false)}
          className="text-sm hover:underline"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  );
}
