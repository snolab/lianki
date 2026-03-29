import { type Grade, Rating } from "ts-fsrs";

// Hybrid Logical Clock for CRDT sync
export type HLC = {
  timestamp: number; // Physical clock (Date.now())
  counter: number; // Logical counter for same timestamp
  deviceId: string; // Device/session identifier
};

/**
 * Compare two HLC timestamps
 * Returns: < 0 if a < b, 0 if equal, > 0 if a > b
 */
export function compareHLC(a: HLC | undefined, b: HLC | undefined): number {
  if (!a) return -1;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

/**
 * Generate new HLC timestamp for server
 */
export function newServerHLC(lastHLC?: HLC | null): HLC {
  const now = Date.now();
  const deviceId = "server";

  if (!lastHLC || now > lastHLC.timestamp) {
    return { timestamp: now, counter: 0, deviceId };
  }

  // Same timestamp - increment counter
  return {
    timestamp: lastHLC.timestamp,
    counter: lastHLC.counter + 1,
    deviceId,
  };
}

export const RATING_MAP: Record<string, Grade> = {
  "1": Rating.Again,
  again: Rating.Again,
  "2": Rating.Hard,
  hard: Rating.Hard,
  "3": Rating.Good,
  good: Rating.Good,
  "4": Rating.Easy,
  easy: Rating.Easy,
};

/**
 * Build a MongoDB query for the next due card.
 * @param excludeDomains - comma-separated domain list from query params
 * @param excludeUrl - URL of the just-reviewed card to exclude from results
 */
export function buildNextDueQuery(excludeDomains: string[], excludeUrl?: string) {
  const query: any = {
    "card.due": { $lte: new Date() },
    url: { $exists: true, $ne: null },
  };
  if (excludeUrl) {
    query.url = { ...query.url, $nin: [excludeUrl] };
  }
  if (excludeDomains.length > 0) {
    query.url = {
      ...query.url,
      $not: new RegExp(excludeDomains.map((d) => d.replace(/\./g, "\\.")).join("|")),
    };
  }
  return query;
}
