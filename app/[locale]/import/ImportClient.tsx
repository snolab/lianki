"use client";

import { useCallback, useRef, useState } from "react";

type ImportResult = {
  success: boolean;
  imported: number;
  skipped: number;
  deckName: string;
  totalNotes: number;
  message: string;
};

export default function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    if (!f.name.endsWith(".apkg")) {
      setError("Please select an .apkg file");
      return;
    }
    setFile(f);
    setError(null);
    setResult(null);
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/import/anki", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401) {
          setError("Please sign in to import decks");
          return;
        }
        throw new Error(data.error || "Import failed");
      }

      setResult(data);
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold mb-4">Import Anki Deck</h1>
        <p className="text-lg mb-8 text-gray-600 dark:text-gray-400">
          Upload an .apkg file to import your Anki flashcards into Lianki
        </p>

        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
              : "border-gray-300 dark:border-gray-700 hover:border-gray-400"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".apkg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />

          {file ? (
            <div>
              <div className="text-lg font-medium">{file.name}</div>
              <div className="text-sm text-gray-500 mt-1">
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </div>
            </div>
          ) : (
            <div>
              <div className="text-lg text-gray-500 mb-2">
                Drop your .apkg file here or click to browse
              </div>
              <div className="text-sm text-gray-400">Max 100MB</div>
            </div>
          )}
        </div>

        {/* Upload button */}
        {file && (
          <button
            onClick={handleUpload}
            disabled={isUploading}
            className="w-full mt-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {isUploading ? "Importing..." : "Import Deck"}
          </button>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
            {error}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="mt-4 p-6 bg-green-50 dark:bg-green-900/20 rounded-lg">
            <h2 className="text-xl font-semibold text-green-700 dark:text-green-400 mb-2">
              Import Complete
            </h2>
            <div className="space-y-1 text-sm">
              <div>
                Deck: <strong>{result.deckName}</strong>
              </div>
              <div>Imported: {result.imported} cards</div>
              {result.skipped > 0 && <div>Skipped: {result.skipped} (already existed)</div>}
              <div>Total notes in deck: {result.totalNotes}</div>
            </div>
            <a
              href="/list"
              className="inline-block mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
            >
              View Dashboard
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
