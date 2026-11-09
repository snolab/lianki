"use client";

/**
 * The first steps of /self-intro (docs/self-intro-import.md):
 *   1. import: the user writes about themselves and/or adds files;
 *   2. facts: what the AI found, one item each, kept / edited / dropped;
 *   3. review: the fields made from the kept facts, all editable.
 * Then `onDone(fields)` hands them to the interview as its answers.
 *
 * Files picked or dropped upload at once into the user's own file store
 * (lib/import/files.ts, source `self-intro`; listed on /my/files), each with
 * its progress; × deletes one for good after a short Undo. The analysis reads
 * the stored files on the server (/api/self-intro/import, `fileIds`) and is
 * offered only when the user's credits cover its smallest hold.
 */
import { useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  IMPORT,
  SELF_INTRO_FIELDS,
  emptyFields,
  type SelfIntroField,
  type SelfIntroFields,
} from "@/lib/self-intro/import-config";
import { pendingDeletes, uploadFile, type UploadResult } from "@/lib/import/uploads-client";
import PartnerQuestions, { type NewFact } from "./PartnerQuestions";

type Fact = {
  id: number;
  field: SelfIntroField;
  value: string;
  certain: boolean;
  status: "pending" | "kept" | "dropped";
  editing: boolean;
  /** Came from an answer to a Learning Partner question, not from the material. */
  fromAnswer?: boolean;
};

const FIELD_LABEL = {
  name: "fieldName",
  from: "fieldFrom",
  age: "fieldAge",
  occupation: "fieldOccupation",
  hobby: "fieldHobby",
  languages: "fieldLanguages",
} as const satisfies Record<SelfIntroField, string>;

/** One file of the add-file area: uploading (progress), stored (id), or failed. */
type Upload = {
  key: string;
  name: string;
  size: number;
  progress: number;
  id?: string;
  error?: Exclude<UploadResult, { ok: true }>["error"];
  abort?: () => void;
};

/** The top-up page (TOP_UP_PATH in lib/payments/metered.ts, a server module). */
const TOP_UP = "/membership";

/** The kept facts of one field as one value, joined the way the page's language lists things. */
function joinFacts(values: string[], locale: string): string {
  if (values.length < 2) return values[0] ?? "";
  try {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(values);
  } catch {
    return values.join(", ");
  }
}

const btnPrimary =
  "px-5 py-2.5 rounded-lg font-medium bg-[oklch(0.55_0.18_255)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.18_255)] disabled:opacity-50 disabled:cursor-not-allowed";
const btnQuiet =
  "px-5 py-2.5 rounded-lg text-[oklch(0.5_0.16_255)] dark:text-[oklch(0.78_0.12_255)] hover:bg-[oklch(0.55_0.18_255/0.08)]";
const muted = "text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)]";
const errorText = "text-sm text-[oklch(0.55_0.2_27)] dark:text-[oklch(0.74_0.15_27)]";
const inputBox =
  "w-full rounded-lg border border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)] bg-[oklch(1_0_0)] dark:bg-[oklch(0.24_0.01_260)] p-3 focus:outline-2 focus:outline-[oklch(0.55_0.18_255)]";

export default function ImportStep({
  onDone,
  onSkip,
  filesOn = false,
}: {
  onDone: (fields: SelfIntroFields) => void;
  onSkip: () => void;
  /** The add-file area (the user's file store, `import.any`); off: text only. */
  filesOn?: boolean;
}) {
  const c = useIntlayer("self-intro-import");
  const { locale } = useLocale();
  const [phase, setPhase] = useState<"input" | "facts" | "review">("input");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Upload[]>([]);
  const [quota, setQuota] = useState<{ available: boolean; need: number; have: number } | null>(
    null,
  );
  const [toast, setToast] = useState<Upload | null>(null);
  const deletes = useRef<ReturnType<typeof pendingDeletes> | null>(null);
  deletes.current ??= pendingDeletes();
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [fields, setFields] = useState<SelfIntroFields>(emptyFields);
  const picker = useRef<HTMLInputElement>(null);

  // May this user start an analysis (credits for its smallest hold)? Asked once.
  useEffect(() => {
    fetch("/api/self-intro/import", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { available?: boolean; need?: number; have?: number } | null) =>
        setQuota({ available: !!b?.available, need: b?.need ?? 0, have: b?.have ?? 0 }),
      )
      .catch(() => setQuota({ available: false, need: 0, have: 0 }));
  }, []);
  // A delete still in its Undo window is sent when the page is left.
  useEffect(() => {
    const flush = () => deletes.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const patch = (key: string, p: Partial<Upload>) =>
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...p } : f)));

  /** Picked or dropped: each file uploads at once into the user's file store. */
  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    // Copied now: the picker's FileList is emptied when its value is reset.
    const picked = Array.from(list);
    const fresh: Upload[] = [];
    for (const f of picked) {
      if (files.length + fresh.length >= IMPORT.maxFiles) break;
      if (files.some((x) => x.name === f.name && x.size === f.size && !x.error)) continue;
      const key = `${f.name}:${f.size}:${crypto.randomUUID()}`;
      const up = uploadFile(f, "self-intro", (progress) => patch(key, { progress }));
      fresh.push({ key, name: f.name, size: f.size, progress: 0, abort: up.abort });
      void up.done.then((r) =>
        r.ok
          ? patch(key, { id: r.id, progress: 1, abort: undefined })
          : r.error === "aborted"
            ? undefined
            : patch(key, { error: r.error, abort: undefined }),
      );
    }
    if (fresh.length) setFiles((prev) => [...prev, ...fresh]);
  };

  /** ×: an upload in flight is cancelled; a stored file is deleted for good (after Undo). */
  const removeFile = (f: Upload) => {
    setFiles((prev) => prev.filter((x) => x.key !== f.key));
    if (f.abort) f.abort();
    if (f.id) {
      deletes.current?.remove(f.id);
      setToast(f);
    }
  };
  const undoRemove = () => {
    if (toast?.id && deletes.current?.undo(toast.id)) setFiles((prev) => [...prev, toast]);
    setToast(null);
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const uploadMessage = (f: Upload) =>
    (f.error === "too-large"
      ? c.errTooLarge
      : f.error === "full"
        ? c.uploadFull
        : c.uploadFailed
    ).value.replace("{file}", f.name);

  const fileMessage = (code: string, name: string) => {
    const msg =
      {
        unsupported: c.errUnsupported,
        "too-large": c.errTooLarge,
        empty: c.errEmpty,
      }[code] ?? c.errUnreadable;
    return msg.value.replace("{file}", name);
  };

  const recognize = async () => {
    setBusy(true);
    setError(null);
    setFileErrors([]);
    const stored = files.filter((f) => f.id);
    try {
      const r = await fetch("/api/self-intro/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, fileIds: stored.map((f) => f.id), locale }),
      });
      const b = (await r.json().catch(() => ({}))) as {
        facts?: { field: SelfIntroField; value: string; certain: boolean }[];
        truncated?: boolean;
        fileErrors?: { id: string; code: string }[];
        need?: number;
        balance?: number;
      };
      const nameOf = (id: string) => stored.find((f) => f.id === id)?.name ?? id;
      setFileErrors((b.fileErrors ?? []).map((e) => fileMessage(e.code, nameOf(e.id))));
      if (r.status === 402) {
        setQuota({ available: false, need: b.need ?? 0, have: b.balance ?? 0 });
        return;
      }
      if (r.status === 429) throw new Error("rate");
      if (!r.ok || !b.facts) throw new Error("failed");
      setTruncated(!!b.truncated);
      setFacts(b.facts.map((f, id) => ({ ...f, id, status: "pending", editing: false })));
      setPhase("facts");
    } catch (e) {
      setError((e instanceof Error && e.message === "rate" ? c.errRate : c.errFailed).value);
    } finally {
      setBusy(false);
    }
  };

  /** An answer's facts join the list, to keep, edit or drop like the material's. */
  const addAnswerFacts = (got: NewFact[]) =>
    setFacts((prev) => {
      let id = prev.reduce((n, f) => Math.max(n, f.id), -1);
      return [
        ...prev,
        ...got.map((f) => ({
          ...f,
          id: ++id,
          status: "pending" as const,
          editing: false,
          fromAnswer: true,
        })),
      ];
    });

  const update = (id: number, patch: Partial<Fact>) =>
    setFacts((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const toReview = () => {
    const next = emptyFields();
    for (const k of SELF_INTRO_FIELDS)
      next[k] = joinFacts(
        facts
          .filter((f) => f.field === k && f.status === "kept" && f.value.trim())
          .map((f) => f.value.trim()),
        locale,
      ).slice(0, IMPORT.maxFieldChars);
    setFields(next);
    setPhase("review");
  };

  if (phase === "input") {
    const uploading = files.some((f) => !f.id && !f.error);
    const canSend =
      (text.trim() || files.some((f) => f.id)) && !busy && !uploading && !!quota?.available;
    return (
      <div className="min-h-screen px-4 py-8 md:p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">{c.heading}</h1>
          <p className={`mb-6 ${muted}`}>{c.intro}</p>

          <label htmlFor="self-intro-about" className="block font-semibold mb-2">
            {c.textLabel}
          </label>
          <textarea
            id="self-intro-about"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={c.textPlaceholder.value}
            rows={7}
            maxLength={IMPORT.maxTextChars}
            className={`${inputBox} text-base mb-4 resize-y`}
          />

          {filesOn && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`rounded-lg border-2 border-dashed p-4 mb-3 transition-colors ${
                  dragging
                    ? "border-[oklch(0.55_0.18_255)] bg-[oklch(0.55_0.18_255/0.06)]"
                    : "border-[oklch(0.85_0.01_260)] dark:border-[oklch(0.4_0.02_260)]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => picker.current?.click()}
                    className="px-4 py-2 rounded-lg font-medium border border-[oklch(0.55_0.18_255)] text-[oklch(0.5_0.16_255)] dark:text-[oklch(0.78_0.12_255)]"
                  >
                    {c.addFiles}
                  </button>
                  <span className={`text-sm ${muted}`}>{c.dropHint}</span>
                </div>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,.docx,.txt,.md,.csv,.tsv,.json,.html,.htm,.srt,.vtt,.xlsx,.zip,image/*,application/pdf"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                {files.length > 0 && (
                  <ul className="flex flex-wrap gap-2 mt-3" data-qa="self-intro-files">
                    {files.map((f) => (
                      <li
                        key={f.key}
                        data-qa="self-intro-file"
                        data-stored={f.id ? "1" : undefined}
                        className={`flex items-center gap-1 max-w-full rounded-full pl-3 pr-1 py-1 text-sm ${
                          f.error ? "bg-[oklch(0.6_0.2_27/0.12)]" : "bg-[oklch(0.55_0.18_255/0.1)]"
                        }`}
                      >
                        <span className="truncate">{f.name}</span>
                        {!f.id && !f.error && (
                          <span
                            className={`shrink-0 text-xs tabular-nums ${muted}`}
                            aria-live="polite"
                          >
                            {c.uploadingFile.value.replace(
                              "{percent}",
                              String(Math.round(f.progress * 100)),
                            )}
                          </span>
                        )}
                        <button
                          type="button"
                          data-qa="self-intro-file-remove"
                          aria-label={c.removeFile.value.replace("{file}", f.name)}
                          onClick={() => removeFile(f)}
                          className="w-7 h-7 rounded-full shrink-0 hover:bg-[oklch(0.55_0.18_255/0.15)]"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className={`text-sm mb-4 ${muted}`}>
                🔒 {c.storedPrivacy}{" "}
                <a href="/my/files" className="underline">
                  {c.myFiles}
                </a>
              </p>
            </>
          )}

          {files
            .filter((f) => f.error)
            .map((f) => (
              <p key={f.key} className={errorText}>
                {uploadMessage(f)}
              </p>
            ))}

          {fileErrors.map((m) => (
            <p key={m} className={errorText}>
              {m}
            </p>
          ))}
          {error && <p className={`${errorText} mb-2`}>{error}</p>}

          <div className="flex flex-col-reverse sm:flex-row gap-3 mt-4">
            <button type="button" onClick={onSkip} className={btnQuiet}>
              {c.skip}
            </button>
            {quota && !quota.available ? (
              <p className="text-sm sm:flex-1" data-qa="self-intro-credits-short">
                {c.creditsShort.value
                  .replace("{need}", quota.need.toLocaleString(locale))
                  .replace("{have}", quota.have.toLocaleString(locale))}{" "}
                <a href={TOP_UP} className="underline font-medium">
                  {c.getCredits}
                </a>
              </p>
            ) : (
              <button
                type="button"
                data-qa="self-intro-start"
                onClick={recognize}
                disabled={!canSend}
                className={`${btnPrimary} sm:flex-1`}
              >
                {busy ? c.recognizing : c.recognize}
              </button>
            )}
          </div>
          {toast && (
            <div
              role="status"
              data-qa="self-intro-deleted"
              className="fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-[oklch(0.25_0.02_260/0.92)] px-4 py-3 text-sm text-[oklch(0.97_0_0)]"
            >
              <span className="min-w-0 flex-1 truncate">
                {c.deletedFile.value.replace("{file}", toast.name)}
              </span>
              <button type="button" onClick={undoRemove} className="font-semibold underline">
                {c.undo}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "facts") {
    const anyPending = facts.some((f) => f.status === "pending");
    return (
      <div className="min-h-screen px-4 py-8 md:p-8">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold mb-2">{c.factsHeading}</h2>
          <p className={`mb-4 ${muted}`}>{facts.length ? c.factsIntro : c.noneFound}</p>
          {truncated && <p className={`text-sm mb-4 ${muted}`}>{c.truncated}</p>}
          {anyPending && (
            <button
              type="button"
              onClick={() =>
                setFacts((prev) =>
                  prev.map((f) => (f.status === "pending" ? { ...f, status: "kept" } : f)),
                )
              }
              className={`${btnQuiet} mb-4 -ml-3`}
            >
              ✓ {c.keepAll}
            </button>
          )}
          <div className="space-y-6 mb-8">
            {SELF_INTRO_FIELDS.map((k) => {
              const list = facts.filter((f) => f.field === k);
              if (!list.length) return null;
              return (
                <section key={k}>
                  <h3 className={`text-sm font-semibold uppercase tracking-wide mb-2 ${muted}`}>
                    {c[FIELD_LABEL[k]]}
                  </h3>
                  <ul className="divide-y divide-[oklch(0.9_0.01_260)] dark:divide-[oklch(0.35_0.02_260)]">
                    {list.map((f) => (
                      <li key={f.id} className="flex items-center gap-2 py-2">
                        <div className="flex-1 min-w-0">
                          {f.editing ? (
                            <input
                              autoFocus
                              value={f.value}
                              maxLength={IMPORT.maxFieldChars}
                              onChange={(e) => update(f.id, { value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  update(f.id, { editing: false, status: "kept" });
                              }}
                              className={`${inputBox} py-2`}
                            />
                          ) : (
                            <span
                              className={
                                f.status === "dropped"
                                  ? `line-through ${muted}`
                                  : f.status === "kept"
                                    ? "font-medium"
                                    : ""
                              }
                            >
                              {f.value}
                            </span>
                          )}
                          {!f.certain && f.status !== "dropped" && (
                            <span className="block text-xs text-[oklch(0.55_0.13_70)] dark:text-[oklch(0.8_0.12_80)]">
                              {c.uncertain}
                            </span>
                          )}
                          {f.fromAnswer && (
                            <span className="block text-xs text-[oklch(0.5_0.12_255)] dark:text-[oklch(0.78_0.1_255)]">
                              {c.fromAnswer}
                            </span>
                          )}
                        </div>
                        {f.editing ? (
                          <button
                            type="button"
                            onClick={() => update(f.id, { editing: false, status: "kept" })}
                            className={btnQuiet}
                          >
                            {c.done}
                          </button>
                        ) : (
                          <div className="flex shrink-0">
                            <FactButton
                              label={c.keep.value}
                              on={f.status === "kept"}
                              tone="keep"
                              onClick={() => update(f.id, { status: "kept" })}
                            >
                              ✓
                            </FactButton>
                            <FactButton
                              label={c.edit.value}
                              onClick={() => update(f.id, { editing: true })}
                            >
                              ✎
                            </FactButton>
                            <FactButton
                              label={c.drop.value}
                              on={f.status === "dropped"}
                              tone="drop"
                              onClick={() => update(f.id, { status: "dropped" })}
                            >
                              ✕
                            </FactButton>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          <PartnerQuestions facts={facts} onFacts={addAnswerFacts} />
          <div className="flex flex-col-reverse sm:flex-row gap-3">
            <button type="button" onClick={() => setPhase("input")} className={btnQuiet}>
              {c.back}
            </button>
            <button type="button" onClick={toReview} className={`${btnPrimary} sm:flex-1`}>
              {c.continueLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-8 md:p-8">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-2xl md:text-3xl font-bold mb-2">{c.reviewHeading}</h2>
        <p className={`mb-6 ${muted}`}>{c.reviewIntro}</p>
        <div className="space-y-4 mb-8">
          {SELF_INTRO_FIELDS.map((k) => (
            <div key={k}>
              <label htmlFor={`self-intro-${k}`} className="block font-semibold mb-1">
                {c[FIELD_LABEL[k]]}
              </label>
              <input
                id={`self-intro-${k}`}
                value={fields[k]}
                maxLength={IMPORT.maxFieldChars}
                placeholder={c.reviewEmpty.value}
                onChange={(e) => setFields((prev) => ({ ...prev, [k]: e.target.value }))}
                className={inputBox}
              />
            </div>
          ))}
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <button type="button" onClick={() => setPhase("facts")} className={btnQuiet}>
            {c.back}
          </button>
          <button
            type="button"
            onClick={() => onDone(fields)}
            className={`${btnPrimary} sm:flex-1`}
          >
            {c.continueLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FactButton({
  label,
  on = false,
  tone,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  tone?: "keep" | "drop";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const active =
    tone === "keep"
      ? "bg-[oklch(0.6_0.15_150)] text-[oklch(0.99_0_0)]"
      : "bg-[oklch(0.6_0.17_27)] text-[oklch(0.99_0_0)]";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={tone ? on : undefined}
      title={label}
      onClick={onClick}
      className={`w-10 h-10 rounded-full text-lg ${
        on ? active : "hover:bg-[oklch(0.55_0.02_260/0.12)]"
      }`}
    >
      {children}
    </button>
  );
}
