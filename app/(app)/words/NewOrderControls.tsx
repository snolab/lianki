"use client";

/**
 * "How new words come": one parent's settings and the live preview
 * (docs/new-word-scheduler.md, section 5). The /dev/new-order simulator uses
 * these now; a group row's ⋯ menu on /words will use the same two, so the
 * menu and the simulator always agree.
 */
import { useMemo } from "react";
import { useIntlayer } from "next-intlayer";
import {
  DEFAULT_PASS_AT,
  type NewOrderMode,
  type NodeOrder,
  type OrderNode,
  planNew,
  type Resolved,
  tally,
} from "@/lib/words/new-order";

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** A list's colour in strips and legends: hues spread by the golden angle, mid lightness for both themes. */
export const leafColor = (i: number) => `oklch(0.7 0.15 ${Math.round((i * 137.508 + 30) % 360)})`;

export function useModeName() {
  const text = useIntlayer("new-order");
  return (m: NewOrderMode) =>
    m === "seq"
      ? text.modeSeq.value
      : m === "rr"
        ? text.modeRr.value
        : m === "weighted"
          ? text.modeWeighted.value
          : text.modeStagger.value;
}

/** "Next 10 new words: N5×6, N4×3, N3×1", with a strip of coloured cells. */
export function NewOrderPreview({
  root,
  n = 10,
  names,
  colors,
  orders,
}: {
  root: OrderNode;
  n?: number;
  /** The settings resolved over the whole tree, when `root` is a subtree. */
  orders?: Map<string, Resolved>;
  names: Map<string, string>;
  colors: Map<string, string>;
}) {
  const text = useIntlayer("new-order");
  const plan = useMemo(() => planNew(root, n, undefined, orders), [root, n, orders]);
  if (!plan.length) return <p className="text-sm opacity-70">{text.noneLeft}</p>;
  return (
    <div className="space-y-1" data-new-order-preview>
      <p className="text-sm tabular-nums">
        <span className="opacity-70">{fill(text.nextN.value, { n })}</span>{" "}
        {tally(plan)
          .map(([id, k]) => `${names.get(id) ?? id}×${k}`)
          .join(", ")}
      </p>
      <div className="flex gap-0.5" aria-hidden>
        {plan.map((id, i) => (
          <span
            key={i}
            className="h-3 flex-1 rounded-sm"
            style={{ background: colors.get(id) }}
            title={names.get(id) ?? id}
          />
        ))}
      </div>
    </div>
  );
}

const MODES: NewOrderMode[] = ["seq", "rr", "stagger", "weighted"];

/** One parent's settings: mode (or inherit), pass mark, ratio, a weight per child. */
export function NewOrderSettings({
  node,
  resolved,
  inherited,
  isRoot,
  onOrder,
  onWeight,
  children,
}: {
  node: OrderNode;
  /** The settings in effect, own or inherited. */
  resolved: Resolved;
  /** What "Same as above" would give; null on the root, which has its own default. */
  inherited: NewOrderMode | null;
  isRoot: boolean;
  onOrder: (order: NodeOrder) => void;
  onWeight: (childId: string, weight: number) => void;
  /** The preview, under the controls. */
  children?: React.ReactNode;
}) {
  const text = useIntlayer("new-order");
  const modeName = useModeName();
  const own = node.order ?? {};
  const pct = Math.round((resolved.passAt ?? DEFAULT_PASS_AT) * 100);
  const hint = (m: NewOrderMode) =>
    m === "seq"
      ? fill(text.modeSeqHint.value, { pct })
      : m === "rr"
        ? text.modeRrHint.value
        : m === "weighted"
          ? text.modeWeightedHint.value
          : text.modeStaggerHint.value;
  const radio = "flex items-start gap-2 py-1 cursor-pointer";
  return (
    <div className="space-y-3 rounded-lg p-3 bg-black/5 dark:bg-white/5" data-new-order-settings>
      <h3 className="font-medium">{text.howNew}</h3>
      <fieldset className="space-y-0.5">
        {!isRoot && inherited && (
          <label className={radio}>
            <input
              type="radio"
              className="mt-1"
              checked={!own.mode}
              onChange={() => onOrder({ ...own, mode: undefined })}
            />
            <span>{fill(text.inherit.value, { mode: modeName(inherited) })}</span>
          </label>
        )}
        {MODES.map((m) => (
          <label key={m} className={radio}>
            <input
              type="radio"
              className="mt-1"
              checked={isRoot ? resolved.mode === m : own.mode === m}
              onChange={() => onOrder({ ...own, mode: m })}
            />
            <span>
              {modeName(m)}
              <span className="block text-xs opacity-60">{hint(m)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {(resolved.mode === "seq" || resolved.mode === "stagger") && (
        <label className="block text-sm">
          {fill(text.passAt.value, { pct })}
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={pct}
            onChange={(e) => onOrder({ ...own, passAt: Number(e.target.value) / 100 })}
            className="block w-full"
          />
        </label>
      )}
      {resolved.mode === "stagger" && (
        <div className="space-y-2">
          <label className="block text-sm">
            {fill(text.ratio.value, { r: resolved.ratio })}
            <input
              type="range"
              min={1}
              max={4}
              step={0.5}
              value={resolved.ratio}
              onChange={(e) => onOrder({ ...own, ratio: Number(e.target.value) })}
              className="block w-full"
            />
          </label>
        </div>
      )}
      {(resolved.mode === "weighted" || resolved.mode === "stagger") &&
        (node.children?.length ?? 0) > 1 && (
          <div className="space-y-1">
            <div className="text-xs opacity-60">{text.weight}</div>
            {node.children!.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{c.name ?? c.id}</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  inputMode="numeric"
                  value={c.weight ?? 1}
                  aria-label={fill(text.weightOf.value, { name: c.name ?? c.id })}
                  onChange={(e) =>
                    onWeight(
                      c.id,
                      Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))),
                    )
                  }
                  className="w-16 rounded px-2 py-1 bg-black/10 dark:bg-white/10 tabular-nums"
                />
              </label>
            ))}
          </div>
        )}
      {children}
    </div>
  );
}
