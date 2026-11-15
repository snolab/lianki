"use client";

// Settings → 「自己的 AI」: the provider picker (docs/byok.md, "Presets").
// One segmented pill (owner rule, 2026-11-15: many options side by side are
// one big pill with segments, never a row of small pills or a dropdown): every
// provider stays visible, the chosen one filled seal red. Scrolls sideways on a
// narrow screen, keeping the chosen one in view. A radiogroup: one tab stop,
// arrows / Home / End move the choice. It draws whatever list it is given (the
// config key `byok.presets`, then Custom).

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ByokPreset, ModelTier } from "@/lib/byok/presets";
import { keepInView } from "@/app/components/PreferredLangsSettings";

/** The index an arrow / Home / End key moves to, or null for any other key. */
export function stepIndex(key: string, idx: number, n: number, rtl: boolean): number | null {
  const step: Record<string, number> = {
    ArrowRight: rtl ? -1 : 1,
    ArrowDown: 1,
    ArrowLeft: rtl ? 1 : -1,
    ArrowUp: -1,
  };
  if (key in step) return (idx + step[key] + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

export function ByokProviderPicker({
  presets,
  value,
  onPick,
  label,
  customLabel,
}: {
  presets: readonly ByokPreset[];
  value: string;
  onPick: (id: string) => void;
  /** The group's accessible name ("Provider"). */
  label: string;
  /** Custom's name in this locale (the only translated one). */
  customLabel: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const idx = Math.max(
    0,
    presets.findIndex((p) => p.id === value),
  );
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (strip.current && el) keepInView(strip.current, el);
  }, [value]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rtl = strip.current?.closest("[dir=rtl]") != null;
    const i = stepIndex(e.key, idx, presets.length, rtl);
    if (i === null) return;
    e.preventDefault();
    const p = presets[i];
    if (p.id !== value) onPick(p.id);
    strip.current?.querySelector<HTMLElement>(`[data-provider="${p.id}"]`)?.focus();
  };
  return (
    <div
      ref={strip}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      data-testid="byok-provider"
      className="flex max-w-full overflow-x-auto overscroll-x-contain rounded-full bg-[oklch(0.5_0_0/0.1)] p-0.5 [scrollbar-width:none] dark:bg-[oklch(0.8_0_0/0.1)] [&::-webkit-scrollbar]:hidden"
    >
      {presets.map((p, i) => {
        const on = i === idx;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-provider={p.id}
            onClick={() => !on && onPick(p.id)}
            className={`min-h-9 shrink-0 rounded-full px-3 text-sm font-medium whitespace-nowrap ${
              on ? "bg-seal text-[oklch(0.99_0_0)] shadow-sm" : "opacity-75 hover:opacity-100"
            }`}
          >
            {p.id === "custom" ? customLabel : p.name}
          </button>
        );
      })}
    </div>
  );
}

export interface PresetInfoText {
  /** Label above the recommended models. */
  recommended: string;
  tiers: Record<ModelTier, string>;
  /** "Prices at {name}". */
  pricing: string;
  /** "Get an API key". */
  getKey: string;
  /** Shown for a provider a browser cannot call ({name}). */
  serverOnly: string;
}

/**
 * Under the picker: the provider's one-line note, links to its own price list
 * and key page (we show no price: they change), and its recommended models,
 * each with a tier word; a tap puts the model in the model field. One list in
 * one rounded box, the model in use filled seal red.
 */
export function ByokPresetInfo({
  preset,
  note,
  model,
  onModel,
  text,
}: {
  preset: ByokPreset;
  note: string | null;
  model: string;
  onModel: (id: string) => void;
  text: PresetInfoText;
}) {
  const links = [
    preset.pricingUrl && { href: preset.pricingUrl, label: text.pricing, id: "pricing" },
    preset.keyUrl && !preset.keyless && { href: preset.keyUrl, label: text.getKey, id: "key" },
  ].filter((l): l is { href: string; label: string; id: string } => !!l);
  const models = preset.models ?? [];
  if (!note && !links.length && !models.length && preset.browser) return null;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="byok-preset-info">
      {note && <p className="opacity-80">{note}</p>}
      {!preset.browser && (
        <p className="font-medium" data-testid="byok-server-only">
          {text.serverOnly.replaceAll("{name}", preset.name)}
        </p>
      )}
      {links.length > 0 && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map((l) => (
            <a
              key={l.id}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
              data-testid={`byok-link-${l.id}`}
            >
              {l.label.replaceAll("{name}", preset.name)}
            </a>
          ))}
        </p>
      )}
      {models.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{text.recommended}</span>
          <ul className="overflow-hidden rounded-2xl bg-[oklch(0.5_0_0/0.1)] p-0.5 dark:bg-[oklch(0.8_0_0/0.1)]">
            {models.map((m) => {
              const on = m.id === model;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={m.id === model}
                    onClick={() => onModel(m.id)}
                    data-model={m.id}
                    className={`flex min-h-9 w-full items-center justify-between gap-3 rounded-xl px-3 text-start ${
                      on
                        ? "bg-seal text-[oklch(0.99_0_0)] shadow-sm"
                        : "hover:bg-[oklch(0.5_0_0/0.08)]"
                    }`}
                  >
                    <span className="min-w-0 break-all font-mono text-xs">{m.id}</span>
                    <span className={`shrink-0 text-xs ${on ? "" : "opacity-70"}`}>
                      {text.tiers[m.tier]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
