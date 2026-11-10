"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { useIntlayer } from "next-intlayer";

/**
 * Every on/off control in the app, drawn as a box seal (owner, 2026-11-11
 * 01:11 JST, replacing the pill switch):
 *
 * - on: a pressed seal — a rectangular stamp filled seal red with the state
 *   word in paper colour ("开" / "Open");
 * - off: the same box, size and place, grey with a dashed outline and the grey
 *   word ("关闭" / "Closed").
 *
 * No track, no knob. Both words share one grid cell (the hidden one keeps its
 * room), so the box never changes size between states. Turning it on plays a
 * short stamp once; none with reduced motion. Colours are the `--lk-seal-*`
 * tokens in app/globals.css (contrast: unit/seal-switch.test.ts). Seal red is
 * the brand, not danger (docs/design-principles.md).
 *
 * `SealSwitch` is the button (role="switch", or "checkbox" for a choice that
 * is submitted with a form); name it from its row with `aria-label` or
 * `aria-labelledby`. A row that is itself the switch (a menu item, a pill with
 * its label) draws `SealStamp` inside its own control.
 */
export type SealSize = "sm" | "md";

export function SealStamp({ on, size = "md" }: { on: boolean; size?: SealSize }) {
  const words = useIntlayer("seal-switch");
  const [stamp, setStamp] = useState(false);
  const was = useRef(on);
  useEffect(() => {
    if (on && !was.current) setStamp(true);
    was.current = on;
  }, [on]);
  return (
    <span
      aria-hidden="true"
      className="lk-seal"
      data-seal={on ? "on" : "off"}
      data-size={size}
      data-stamping={stamp || undefined}
      onAnimationEnd={() => setStamp(false)}
    >
      <span data-word="on">{words.on.value}</span>
      <span data-word="off">{words.off.value}</span>
    </span>
  );
}

export function SealSwitch({
  checked,
  size = "md",
  role = "switch",
  className = "",
  ...rest
}: {
  checked: boolean;
  size?: SealSize;
  role?: "switch" | "checkbox";
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "type">) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      data-seal-check={checked ? "on" : "off"}
      className={`lk-seal-switch ${className}`}
      {...rest}
    >
      <SealStamp on={checked} size={size} />
    </button>
  );
}
