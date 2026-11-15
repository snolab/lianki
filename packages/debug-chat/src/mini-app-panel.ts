export type MiniAppSizing = { height: number; minHeight: number; step: number };
export function clampMiniAppHeight(height: number, viewport: number, minHeight: number): number {
  const max = Number.isFinite(viewport) ? Math.max(0, viewport) : 0;
  const min = Number.isFinite(minHeight) ? Math.min(max, Math.max(0, minHeight)) : 0;
  return Math.min(max, Math.max(min, Number.isFinite(height) ? height : min));
}
export function miniAppKeyHeight(
  key: string,
  height: number,
  viewport: number,
  sizing: MiniAppSizing,
): number | null {
  const step = Number.isFinite(sizing.step) ? Math.max(0, sizing.step) : 0;
  const next =
    key === "ArrowUp"
      ? height + step
      : key === "ArrowDown"
        ? height - step
        : key === "Home"
          ? sizing.minHeight
          : key === "End"
            ? viewport
            : null;
  return next === null ? null : clampMiniAppHeight(next, viewport, sizing.minHeight);
}

export type MiniAppEmbedView = {
  slug: string;
  name: string;
  icon: string;
  version: string;
  style: "lianki" | "none";
  permissions: string[];
  grants: Record<string, string>;
  frame: { mode: "srcdoc"; srcdoc: string; sandbox: "allow-scripts allow-forms" };
};
/** Embedded cards never accept a remote-frame mode or a same-origin sandbox. */
export function miniAppEmbedView(raw: unknown, slug: string): MiniAppEmbedView | null {
  if (!raw || typeof raw !== "object") return null;
  const view = raw as Record<string, unknown>;
  const frame = view.frame as Record<string, unknown> | null;
  if (
    view.slug !== slug ||
    typeof view.name !== "string" ||
    typeof view.icon !== "string" ||
    typeof view.version !== "string" ||
    !["lianki", "none"].includes(view.style as string) ||
    !Array.isArray(view.permissions) ||
    !view.permissions.every((p) => typeof p === "string") ||
    !view.grants ||
    typeof view.grants !== "object" ||
    Array.isArray(view.grants) ||
    !Object.values(view.grants).every((v) => typeof v === "string") ||
    !frame ||
    frame.mode !== "srcdoc" ||
    typeof frame.srcdoc !== "string" ||
    frame.sandbox !== "allow-scripts allow-forms"
  )
    return null;
  return view as MiniAppEmbedView;
}
