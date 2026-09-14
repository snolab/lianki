import type { Card, ReviewLog } from "ts-fsrs";
import type { HLC } from "./hlc";

// Framework-agnostic FSRS note shape. Lives in @lianki/core so the CF-native
// worker and the D1 repos can import it without pulling in next/cache, fs, or
// OpenNext context. lib/core/fsrsNote.ts + app/fsrs.ts re-export it.
export type FSRSNote = {
  url: string;
  title?: string;
  card: Card;
  log?: ReviewLog[]; // Review history
  notes?: string; // User notes, max 128 chars
  speedMarkers?: Record<number, number>; // {timestamp: speed}
  hlc?: HLC; // Hybrid Logical Clock for sync
  deviceId?: string; // Last device that modified (legacy field)
};
