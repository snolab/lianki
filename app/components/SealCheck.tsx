"use client";

import type { ButtonHTMLAttributes } from "react";

/**
 * An on/off control drawn as a seal (印): on = a seal-red stamp with 印 carved
 * in paper, set at a slight tilt like a hand-pressed chop; off = an empty box
 * waiting for the stamp. Replaces green switches on the /dev pages (owner,
 * 2026-11-10). Seal red is the brand, not danger (docs/design-principles.md).
 *
 * Contrast: paper on seal 5.6:1 (the carved glyph), the empty box's edge
 * gray-500 on paper / gray-400 on ink ≥ 3:1 (a UI boundary).
 *
 * Pass `role="switch"` for a setting that saves at once, or leave the default
 * `checkbox` for one that is submitted with a form.
 */
export function SealCheck({
  checked,
  size = 28,
  role = "checkbox",
  className = "",
  ...rest
}: {
  checked: boolean;
  size?: number;
  role?: "checkbox" | "switch";
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role">) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      data-seal-check={checked ? "on" : "off"}
      className={`group relative inline-grid shrink-0 place-items-center rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-300 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      style={{ width: size + 8, height: size + 8 }}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={`grid place-items-center rounded-[5px] transition-transform duration-150 motion-reduce:transition-none ${
          checked
            ? "-rotate-6 border-2 border-blue-600 bg-blue-600 text-white"
            : "border-2 border-gray-500 bg-transparent dark:border-gray-400"
        }`}
        style={{ width: size, height: size }}
      >
        {checked && (
          <span
            className="font-brush leading-none select-none"
            style={{ fontSize: Math.round(size * 0.62) }}
          >
            印
          </span>
        )}
      </span>
    </button>
  );
}
