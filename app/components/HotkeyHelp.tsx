"use client";

import { useEffect, useState } from "react";

const SHORTCUTS = [
  { keys: "1 / d / l", action: "Again" },
  { keys: "2 / s / j", action: "Hard" },
  { keys: "3", action: "Good" },
  { keys: "4 / a / h", action: "Easy" },
  { keys: "5 / m / t", action: "Delete" },
  { keys: "↑ / i", action: "Previous" },
  { keys: "↓ / k", action: "Next" },
];

export function HotkeyHelp() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.isContentEditable)
      )
        return;
      if (e.key === "?") {
        e.preventDefault();
        setVisible((v) => !v);
      }
      if (e.key === "Escape" && visible) {
        setVisible(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4 w-64">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Keyboard Shortcuts</h3>
        <button
          onClick={() => setVisible(false)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
        >
          ESC
        </button>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.action}>
              <td className="py-0.5 pr-3 font-mono text-gray-500 dark:text-gray-400">{s.keys}</td>
              <td className="py-0.5">{s.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-2">
        Press <kbd className="font-mono">?</kbd> to toggle
      </div>
    </div>
  );
}
