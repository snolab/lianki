// Bring your own AI (docs/byok.md): the providers a user can pick, live.
// The data and the relay allowlist are in ./preset-data.ts; this file reads
// the live rows from the public config key `byok.presets` (lib/config.ts,
// editable at /dev/config) in the browser. On the server, or before the app
// layout hands the config over, that is the code default.
//
// The relay server never reads this: it trusts `relayPresetOf` (code only).

import { publicCfg } from "@/lib/config-client";
import { presetsFrom, type ByokPreset, type ByokPresetRow } from "./preset-data";

export {
  BYOK_PRESETS,
  CUSTOM_PRESET,
  DEFAULT_PRESET_ROWS,
  MODEL_RE,
  MODEL_TIERS,
  RELAY_PRESETS,
  presetsFrom,
  relayPresetOf,
  type ByokModelPick,
  type ByokPreset,
  type ByokPresetRow,
  type ByokProtocol,
  type ModelTier,
} from "./preset-data";

let memo: { rows: readonly ByokPresetRow[]; list: ByokPreset[] } | null = null;

/** The presets in effect now (the config's rows, then Custom). */
export function livePresets(): readonly ByokPreset[] {
  const rows = publicCfg("byok.presets");
  if (memo?.rows !== rows) memo = { rows, list: presetsFrom(rows) };
  return memo.list;
}

export const presetOf = (id: string | null | undefined): ByokPreset | null =>
  livePresets().find((p) => p.id === id) ?? null;

/** The preset's one-line note in this locale (its config `note`), or null. */
export function rowNote(p: ByokPresetRow, locale: string): string | null {
  const n = p.note;
  if (!n) return null;
  return n[locale] ?? n[locale.split("-")[0]] ?? n.en ?? null;
}
