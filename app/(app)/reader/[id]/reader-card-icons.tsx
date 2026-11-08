"use client";

import { Icon, type IconName } from "@/app/components/icons";

/** One icon action of the card's top row; its label is its name and its tooltip. */
export interface IconAction {
  action: string;
  icon: IconName;
  label: string;
  run: () => void;
  testId?: string;
}

/**
 * The card's icon group (owner, 2026-11-05 02:10 JST): read aloud, copy the
 * text, copy the link — icons only (Phosphor, app/components/icons.tsx), in
 * currentColor, each named by its label for screen readers and as a tooltip.
 * 44px tap targets on touch, compact under a fine pointer.
 */
export function CardIcons({ items }: { items: IconAction[] }) {
  return (
    <div className="flex items-center" data-testid="read-select-icons">
      {items.map((x) => (
        <button
          key={x.action}
          type="button"
          onClick={x.run}
          aria-label={x.label}
          title={x.label}
          data-action={x.action}
          data-testid={x.testId}
          className="grid h-11 w-11 place-items-center rounded-full text-xl opacity-80 hover:bg-[oklch(0.5_0_0/0.1)] hover:opacity-100 focus-visible:bg-[oklch(0.5_0_0/0.1)] pointer-fine:h-8 pointer-fine:w-8 pointer-fine:text-lg"
        >
          <Icon name={x.icon} />
        </button>
      ))}
    </div>
  );
}
