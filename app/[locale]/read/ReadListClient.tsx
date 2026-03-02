"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export interface ReadMaterial {
  id: string;
  title: string;
  content?: string;
  lines: string[];
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "lianki-read-materials";
const PAGE_SIZE = 10;

function generateId(): string {
  return crypto.randomUUID();
}

function parseLinesFromContent(content: string): string[] {
  return content
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// LocalStorage helpers for guests
function getLocalMaterials(): ReadMaterial[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function saveLocalMaterials(materials: ReadMaterial[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(materials));
}

export function ReadListClient({ locale, isLoggedIn }: { locale: string; isLoggedIn: boolean }) {
  const router = useRouter();
  const [materials, setMaterials] = useState<ReadMaterial[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  // Load materials
  useEffect(() => {
    async function loadMaterials() {
      setLoading(true);
      if (isLoggedIn) {
        try {
          const res = await fetch(`/api/read?page=${page}&pageSize=${PAGE_SIZE}`);
          if (res.ok) {
            const data = await res.json();
            setMaterials(data.materials);
            setTotalPages(data.totalPages);
          }
        } catch (err) {
          console.error("Failed to load materials:", err);
        }
      } else {
        const local = getLocalMaterials();
        setMaterials(local.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
        setTotalPages(Math.ceil(local.length / PAGE_SIZE) || 1);
      }
      setLoading(false);
    }
    loadMaterials();
  }, [isLoggedIn, page]);

  const handleImport = async () => {
    if (!importText.trim()) return;

    const lines = parseLinesFromContent(importText);
    const title = importTitle.trim() || `Import ${new Date().toLocaleDateString()}`;

    if (isLoggedIn) {
      try {
        const res = await fetch("/api/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content: importText }),
        });
        if (res.ok) {
          const newMaterial = await res.json();
          setImportText("");
          setImportTitle("");
          setIsImporting(false);
          router.push(`/${locale}/read/${newMaterial.id}`);
        }
      } catch (err) {
        console.error("Failed to save material:", err);
      }
    } else {
      const now = new Date().toISOString();
      const newMaterial: ReadMaterial = {
        id: generateId(),
        title,
        content: importText,
        lines,
        createdAt: now,
        updatedAt: now,
      };

      const all = getLocalMaterials();
      const updated = [newMaterial, ...all];
      saveLocalMaterials(updated);
      setImportText("");
      setImportTitle("");
      setIsImporting(false);
      router.push(`/${locale}/read/${newMaterial.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this material?")) return;

    if (isLoggedIn) {
      try {
        await fetch(`/api/read/${id}`, { method: "DELETE" });
        setMaterials((prev) => prev.filter((m) => m.id !== id));
      } catch (err) {
        console.error("Failed to delete:", err);
      }
    } else {
      const all = getLocalMaterials();
      const updated = all.filter((m) => m.id !== id);
      saveLocalMaterials(updated);
      setMaterials((prev) => prev.filter((m) => m.id !== id));
    }
  };

  return (
    <div className="space-y-6">
      {/* Import Button / Form */}
      {!isImporting ? (
        <button
          onClick={() => setIsImporting(true)}
          className="w-full py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors"
        >
          + Import Text Material
        </button>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
          <input
            type="text"
            value={importTitle}
            onChange={(e) => setImportTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste your text here... Each line will become a learning segment."
            rows={10}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y font-mono text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setIsImporting(false);
                setImportText("");
                setImportTitle("");
              }}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!importText.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import ({parseLinesFromContent(importText).length} lines)
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading...</div>
      ) : materials.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No materials imported yet. Click the button above to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {materials.map((material) => (
            <div
              key={material.id}
              className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
            >
              <Link href={`/${locale}/read/${material.id}`} className="flex-1 min-w-0">
                <h3 className="font-medium truncate">{material.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {material.lines.length} lines &middot;{" "}
                  {new Date(material.updatedAt).toLocaleDateString()}
                </p>
              </Link>
              <button
                onClick={() => handleDelete(material.id)}
                className="ml-4 p-2 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                title="Delete"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Prev
          </button>
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
