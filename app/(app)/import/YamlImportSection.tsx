"use client";

import { useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { YAML_UPLOAD } from "@/lib/security/upload-policy";
import { fill } from "./text";

type Result = { notesUpserted: number; goalsUpserted: number; preferencesRestored: boolean };

type YamlError =
  | "yamlWrongType"
  | "yamlSignIn"
  | "yamlNoFile"
  | "yamlTooLarge"
  | "yamlEmpty"
  | "yamlNotBackup"
  | "yamlVersion"
  | "yamlFailed";

/** /api/import/yaml's error codes (and the upload policy's) → the translated line; unknown → generic. */
const ERROR_BY_CODE: Record<string, YamlError> = {
  "login-required": "yamlSignIn",
  "missing-file": "yamlNoFile",
  "wrong-file-type": "yamlWrongType",
  "file-too-large": "yamlTooLarge",
  "file-empty": "yamlEmpty",
  "invalid-yaml": "yamlNotBackup",
  "invalid-export": "yamlNotBackup",
  "not-an-archive": "yamlNotBackup",
  "unsupported-version": "yamlVersion",
};

const isYaml = (f: File) => /\.ya?ml$/i.test(f.name);

export default function YamlImportSection() {
  const t = useIntlayer("import-sections");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<YamlError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleImport() {
    if (!file) return;
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/yaml", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[import] yaml failed", res.status, data);
        setError(ERROR_BY_CODE[String(data?.error)] ?? "yamlFailed");
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
      setFile(null);
    } catch (err) {
      console.warn("[import] yaml failed", err);
      setError("yamlFailed");
      setStatus("error");
    }
  }

  return (
    <div className="mt-10 border-t pt-8">
      <h2 className="text-2xl font-bold mb-2">{t.yamlHeading}</h2>
      <p className="text-gray-600 dark:text-gray-400 mb-6">{t.yamlIntro}</p>

      <div
        className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer hover:border-gray-400 border-gray-300 dark:border-gray-700"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f && isYaml(f)) {
            setFile(f);
            setError(null);
            setStatus("idle");
          } else setError("yamlWrongType");
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (!isYaml(f)) return setError("yamlWrongType");
            setFile(f);
            setError(null);
            setStatus("idle");
          }}
        />
        {file ? (
          <div>
            <div className="font-medium">{file.name}</div>
            <div className="text-sm text-gray-500 mt-1">
              {fill(t.sizeKb, { n: (file.size / 1024).toFixed(1) })}
            </div>
          </div>
        ) : (
          <div className="text-gray-500">{t.yamlDrop}</div>
        )}
      </div>

      {file && status === "idle" && (
        <button
          onClick={handleImport}
          className="w-full mt-4 py-3 bg-primary text-on-primary rounded-lg hover:bg-blue-700 font-medium"
        >
          {t.yamlImport}
        </button>
      )}

      {status === "loading" && <div className="mt-4 text-center text-gray-500">{t.importing}</div>}

      {status === "done" && result && (
        <div className="mt-4 p-6 bg-green-50 dark:bg-green-900/20 rounded-lg">
          <h3 className="font-semibold text-green-700 dark:text-green-400 mb-2">{t.yamlDone}</h3>
          <ul className="text-sm space-y-1">
            <li>{fill(t.yamlNotes, { n: result.notesUpserted })}</li>
            <li>{fill(t.yamlGoals, { n: result.goalsUpserted })}</li>
            <li>{result.preferencesRestored ? t.yamlPrefsYes : t.yamlPrefsNo}</li>
          </ul>
          <a
            href="/list"
            className="inline-block mt-4 px-4 py-2 bg-primary text-on-primary rounded text-sm hover:bg-blue-700"
          >
            {t.yamlGoList}
          </a>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg"
        >
          {error === "yamlTooLarge"
            ? fill(t.yamlTooLarge, { mb: YAML_UPLOAD.maxBytes / (1024 * 1024) })
            : t[error]}
        </div>
      )}
    </div>
  );
}
