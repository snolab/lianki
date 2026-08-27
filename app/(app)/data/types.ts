import type { NoteRow } from "@/app/lib/notesAdmin";

export type StoreId = "cloud" | "local";

/** A table row plus which of the three stores hold this card. */
export type DataRow = NoteRow & {
  inLocal: boolean;
  inCloud: boolean;
  /** Local mirror only: false while the userscript still owes the server. */
  synced?: boolean;
};

export const CARD_STATES = ["New", "Learning", "Review", "Relearning"] as const;

export function stateName(state: number): string {
  return CARD_STATES[state] ?? String(state);
}

/** Human "2d" / "-3h" style delta, matching the list page's `dueMs` output. */
export function dueLabel(iso: string): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const [value, unit] =
    abs < 60_000
      ? [Math.round(abs / 1000), "s"]
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), "m"]
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), "h"]
          : [Math.round(abs / 86_400_000), "d"];
  return `${ms < 0 ? "-" : ""}${value}${unit}`;
}
