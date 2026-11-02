/**
 * Text size (owner, 2026-11-03 03:10 JST): one scale for all the app's text,
 * and one more for each of two areas, the chat (packages/debug-chat) and the
 * study cards (/words slips, the /review card). Kept on the device
 * (`lk:pref:text-size`) and synced with the account (docs/prefs-sync.md,
 * `text-size.*`).
 *
 * Only text scales, not the layout: `html { font-size }` stays the browser's,
 * so spacing and widths in rem keep their size. The scales are CSS custom
 * properties on `<html>`:
 *
 * - `--lk-fs-ui`, `--lk-fs-chat`, `--lk-fs-cards`: the three choices;
 * - `--lk-fs-k`: the factor in effect, `ui` on the page and `ui × area` inside
 *   `.lk-fs-chat` / `.lk-fs-cards` (app/globals.css). Every Tailwind `text-*`
 *   size and the `fs-<px>` utility multiply by it.
 *
 * Set before first paint by TEXT_SIZE_BOOT_SCRIPT (lib/text-size-boot.ts), so a page never flashes
 * at the wrong size. The chat cannot import the app; it only needs the CSS.
 */
import { createUiStore } from "@lianki/ui-state";

/** The steps the controls offer. The schema accepts any value in range. */
export const TEXT_STEPS = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;
export { TEXT_MIN, TEXT_MAX } from "@/lib/text-size-boot";
import { TEXT_MIN, TEXT_MAX } from "@/lib/text-size-boot";

export type TextArea = "ui" | "chat" | "cards";
export const TEXT_AREAS: readonly TextArea[] = ["ui", "chat", "cards"];
export type TextSizes = Record<TextArea, number>;

const DEFAULTS: TextSizes = { ui: 1, chat: 1, cards: 1 };

/** A stored value, or undefined when it is not a scale in range. */
export function asScale(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= TEXT_MIN && v <= TEXT_MAX
    ? v
    : undefined;
}

export const textSizeStore = createUiStore("text-size", 1, { ...DEFAULTS } as TextSizes, {
  storage: "account",
  clean: (v) => {
    const out: Partial<TextSizes> = {};
    for (const a of TEXT_AREAS) {
      const s = asScale((v as Record<string, unknown> | null)?.[a]);
      if (s !== undefined) out[a] = s;
    }
    return out;
  },
});

/** The next step up (+1) or down (-1) from `v`, clamped to the ends. */
export function stepScale(v: number, dir: 1 | -1): number {
  const i = TEXT_STEPS.findIndex((s) => Math.abs(s - v) < 0.001);
  if (i >= 0) return TEXT_STEPS[Math.max(0, Math.min(TEXT_STEPS.length - 1, i + dir))];
  // Off the steps (set elsewhere): to the nearest step in that direction.
  const next =
    dir > 0 ? TEXT_STEPS.find((s) => s > v) : [...TEXT_STEPS].reverse().find((s) => s < v);
  return next ?? v;
}

export function setTextSize(area: TextArea, v: number) {
  const s = asScale(v);
  if (s !== undefined) textSizeStore.setState({ [area]: s } as Partial<TextSizes>);
}

/** The factor text gets in an area: the whole app's, times the area's own. */
export function effectiveScale(sizes: TextSizes, area: TextArea): number {
  return area === "ui" ? sizes.ui : sizes.ui * sizes[area];
}

/** The choices as custom properties on `<html>` (app/globals.css reads them). */
export function applyTextSize(
  root: {
    style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
  } = document.documentElement,
) {
  const s = textSizeStore.getState();
  for (const a of TEXT_AREAS) {
    if (s[a] === 1) root.style.removeProperty(`--lk-fs-${a}`);
    else root.style.setProperty(`--lk-fs-${a}`, String(s[a]));
  }
}

/** Keep the custom properties in step with the store. Returns the unsubscribe. */
export function installTextSize(root?: Parameters<typeof applyTextSize>[0]) {
  applyTextSize(root);
  return textSizeStore.subscribe(() => applyTextSize(root));
}

// Loaded on every page (app/components/PrefSync.tsx), so a value pulled from
// the account or changed in another tab applies at once.
if (typeof window !== "undefined") installTextSize();
