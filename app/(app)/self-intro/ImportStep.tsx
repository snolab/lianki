"use client";

/**
 * The first steps of /self-intro (docs/self-intro-import.md):
 *   1. import: the user writes about themselves and/or adds files;
 *   2. facts: what the AI found, one item each, kept / edited / dropped;
 *   3. review: the fields made from the kept facts, all editable.
 * Then `onDone(fields)` hands them to the interview as its answers.
 *
 * Files are parsed here, on the device (lib/self-intro/import-parse.ts); only
 * the text and shrunk images go to /api/self-intro/import, which stores
 * nothing. Nothing here writes the material to storage either: it lives in
 * this component's state and is gone when the page is left.
 */
import { useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import {
  IMPORT,
  SELF_INTRO_FIELDS,
  emptyFields,
  type SelfIntroField,
  type SelfIntroFields,
} from "@/lib/self-intro/import-config";
import {
  ImportFileError,
  mergeImport,
  parseImportFile,
  type FileLike,
  type ImportPart,
} from "@/lib/self-intro/import-parse";
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

/** An image file as a JPEG data URL, its longer side at most `IMPORT.imageMaxSide`. */
async function shrinkImage(file: FileLike): Promise<string> {
  const blob = file as unknown as Blob;
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await createImageBitmap(blob);
  } catch {
    // Some formats (HEIC in Chrome) only decode through <img>, where the browser can.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const scale = Math.min(1, IMPORT.imageMaxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ("close" in source && typeof source.close === "function") source.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

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
}: {
  onDone: (fields: SelfIntroFields) => void;
  onSkip: () => void;
}) {
  const c = useIntlayer("self-intro-import");
  const { locale } = useLocale();
  const [phase, setPhase] = useState<"input" | "facts" | "review">("input");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [fields, setFields] = useState<SelfIntroFields>(emptyFields);
  const picker = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    // Copied now: the picker's FileList is emptied when its value is reset, before the updater runs.
    const picked = Array.from(list);
    setFiles((prev) => {
      const next = [...prev];
      for (const f of picked)
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      return next.slice(0, IMPORT.maxFiles);
    });
  };

  const fileMessage = (e: unknown, name: string) => {
    const code = e instanceof ImportFileError ? e.code : "unreadable";
    const msg = {
      unsupported: c.errUnsupported,
      "too-large": c.errTooLarge,
      unreadable: c.errUnreadable,
      empty: c.errEmpty,
    }[code];
    return msg.value.replace("{file}", name);
  };

  const recognize = async () => {
    setBusy(true);
    setError(null);
    const errs: string[] = [];
    const parts: ImportPart[] = [];
    for (const f of files) {
      try {
        parts.push(...(await parseImportFile(f, { shrinkImage })));
      } catch (e) {
        errs.push(fileMessage(e, f.name));
      }
    }
    setFileErrors(errs);
    const payload = mergeImport(text, parts);
    if (!payload.text.trim() && !payload.images.length) {
      setBusy(false);
      return;
    }
    try {
      const r = await fetch("/api/self-intro/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload.text, images: payload.images, locale }),
      });
      if (r.status === 429) throw new Error("rate");
      if (!r.ok) throw new Error("failed");
      const { facts: got } = (await r.json()) as {
        facts: { field: SelfIntroField; value: string; certain: boolean }[];
      };
      setTruncated(payload.truncated);
      setFacts(got.map((f, id) => ({ ...f, id, status: "pending", editing: false })));
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
    const canSend = (text.trim() || files.length) && !busy;
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
              accept=".pdf,.docx,.txt,.md,.csv,.json,.html,.htm,.zip,image/*,application/pdf"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2 mt-3">
                {files.map((f) => (
                  <li
                    key={`${f.name}:${f.size}`}
                    className="flex items-center gap-1 max-w-full rounded-full pl-3 pr-1 py-1 text-sm bg-[oklch(0.55_0.18_255/0.1)]"
                  >
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      aria-label={c.removeFile.value.replace("{file}", f.name)}
                      onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                      className="w-7 h-7 rounded-full shrink-0 hover:bg-[oklch(0.55_0.18_255/0.15)]"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className={`text-sm mb-4 ${muted}`}>🔒 {c.privacy}</p>

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
            <button
              type="button"
              onClick={recognize}
              disabled={!canSend}
              className={`${btnPrimary} sm:flex-1`}
            >
              {busy ? c.recognizing : c.recognize}
            </button>
          </div>
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
