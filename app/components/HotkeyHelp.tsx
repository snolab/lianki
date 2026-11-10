"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";

export function HotkeyHelp() {
  const [visible, setVisible] = useState(false);
  const h = useIntlayer("hotkey-help");
  // The grade names as on the review buttons.
  const g = useIntlayer("review-page");

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

  const shortcuts = [
    { keys: "1 / d / l", action: g.again.value },
    { keys: "2 / s / j", action: g.hard.value },
    { keys: "3", action: g.good.value },
    { keys: "4 / a / h", action: g.easy.value },
    { keys: "5 / m / t", action: h.delete.value },
    { keys: "↑ / i", action: h.previous.value },
    { keys: "↓ / k", action: h.next.value },
  ];
  const [before, after = ""] = h.toggle.value.split("{key}");

  return (
    <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-[var(--lk-z-notice)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4 w-64">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">{h.title}</h3>
        <button
          onClick={() => setVisible(false)}
          aria-label={h.close.value}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs"
        >
          ESC
        </button>
      </div>
      <table className="w-full text-xs">
        <tbody>
          {shortcuts.map((s) => (
            <tr key={s.keys}>
              <td className="py-0.5 pr-3 font-mono text-gray-500 dark:text-gray-400">{s.keys}</td>
              <td className="py-0.5">{s.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-2">
        {before}
        <kbd className="font-mono">?</kbd>
        {after}
      </div>
    </div>
  );
}
