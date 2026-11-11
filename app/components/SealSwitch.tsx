"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { useIntlayer } from "next-intlayer";

/**
 * Every on/off control in the app, drawn as a two-part box seal that shows
 * both states at once (owner, 2026-11-11 18:50 JST: "状态转移按钮要明示所有
 * 状态"; the box seal itself is from 01:11 JST, replacing the pill switch):
 *
 *   [ 开 | 关 ]
 *
 * - the side naming the current state is pressed: filled seal red, the word
 *   in paper colour;
 * - the other side stays visible, grey with a dashed outline and the grey
 *   word, so a glance shows what the other state is called and where it is.
 *
 * No track, no knob. The two sides never change size, so the seal is the same
 * box in both states. Changing state stamps the newly pressed side once; none
 * on mount, none with reduced motion. Colours are the `--lk-seal-*` tokens in
 * app/globals.css (contrast: unit/seal-switch.test.ts). Seal red is the brand,
 * not danger (docs/design-principles.md).
 *
 * `SealSwitch` is the button (role="switch", or "checkbox" for a choice that
 * is submitted with a form); name it from its row with `aria-label` or
 * `aria-labelledby`. The words are drawn, not read: the role and
 * `aria-checked` carry the state. A row that is itself the switch (a menu
 * item, a pill with its label) draws `SealStamp` inside its own control.
 */
export type SealSize = "sm" | "md";

export function SealStamp({ on, size = "md" }: { on: boolean; size?: SealSize }) {
  const words = useIntlayer("seal-switch");
  const [stamp, setStamp] = useState(false);
  const was = useRef(on);
  useEffect(() => {
    if (on !== was.current) setStamp(true);
    was.current = on;
  }, [on]);
  return (
    <span
      aria-hidden="true"
      className="lk-sealbox"
      data-seal={on ? "on" : "off"}
      data-size={size}
      data-stamping={stamp || undefined}
      onAnimationEnd={() => setStamp(false)}
    >
      <span data-word="on" data-active={on || undefined}>
        {words.on.value}
      </span>
      <span data-word="off" data-active={!on || undefined}>
        {words.off.value}
      </span>
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
