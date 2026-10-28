"use client";

import { useEffect, useState } from "react";

/** Paper skins (紙紋) — see the `data-paper` rules in app/globals.css. */
const SKINS = [
  { id: "b", name: "宣紙", hint: "Xuan paper fibres (default)" },
  { id: "a", name: "細紙", hint: "Fine grain, the plainest" },
  { id: "c", name: "和紙", hint: "Faint washi clouds" },
  { id: "e", name: "手漉紙", hint: "Handmade, lit relief" },
] as const;

/** localStorage key, read before first paint by the inline script in app/layout.tsx. */
export const PAPER_KEY = "lk:paper";

export function PaperSkinPicker() {
  const [skin, setSkin] = useState("b");
  useEffect(() => setSkin(document.documentElement.dataset.paper || "b"), []);

  const pick = (id: string) => {
    setSkin(id);
    document.documentElement.dataset.paper = id;
    try {
      localStorage.setItem(PAPER_KEY, id);
    } catch {}
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {SKINS.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => pick(s.id)}
          aria-pressed={skin === s.id}
          className={`text-left p-3 rounded border transition-colors ${
            skin === s.id
              ? "border-blue-600 bg-blue-600/10"
              : "border-gray-300 dark:border-gray-700 hover:border-gray-500"
          }`}
        >
          <span className="block font-brush text-xl">{s.name}</span>
          <span className="block text-xs text-gray-500">{s.hint}</span>
        </button>
      ))}
    </div>
  );
}
