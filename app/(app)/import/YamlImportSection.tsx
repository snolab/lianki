"use client";

import { useRef, useState } from "react";

type Result = { notesUpserted: number; goalsUpserted: number; preferencesRestored: boolean };

export default function YamlImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setResult(data);
      setStatus("done");
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStatus("error");
    }
  }

  return (
    <div className="mt-10 border-t pt-8">
      <h2 className="text-2xl font-bold mb-2">Import Lianki YAML backup</h2>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        Restore a previously exported <code>.yaml</code> file to migrate your notes, roadmap goals,
        and preferences.
      </p>

      <div
        className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer hover:border-gray-400 border-gray-300 dark:border-gray-700"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f?.name.endsWith(".yaml") || f?.name.endsWith(".yml")) setFile(f);
          else setError("Please select a .yaml file");
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setFile(f);
          }}
        />
        {file ? (
          <div>
            <div className="font-medium">{file.name}</div>
            <div className="text-sm text-gray-500 mt-1">{(file.size / 1024).toFixed(1)} KB</div>
          </div>
        ) : (
          <div className="text-gray-500">
            Drop a lianki-export-*.yaml file here, or click to select
          </div>
        )}
      </div>

      {file && status === "idle" && (
        <button
          onClick={handleImport}
          className="w-full mt-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
        >
          Import YAML
        </button>
      )}

      {status === "loading" && <div className="mt-4 text-center text-gray-500">Importing...</div>}

      {status === "done" && result && (
        <div className="mt-4 p-6 bg-green-50 dark:bg-green-900/20 rounded-lg">
          <h3 className="font-semibold text-green-700 dark:text-green-400 mb-2">Import complete</h3>
          <ul className="text-sm space-y-1">
            <li>Notes restored: {result.notesUpserted}</li>
            <li>Roadmap goals restored: {result.goalsUpserted}</li>
            <li>Preferences restored: {result.preferencesRestored ? "yes" : "no"}</li>
          </ul>
          <a
            href="/list"
            className="inline-block mt-4 px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            Go to dashboard
          </a>
        </div>
      )}

      {error && (
        <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
}
