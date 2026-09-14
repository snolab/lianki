// Hybrid Logical Clock for CRDT sync. Framework-neutral (no ts-fsrs, no DB).
export type HLC = {
  timestamp: number; // Physical clock (Date.now())
  counter: number; // Logical counter for same timestamp
  deviceId: string; // Device/session identifier
};

/**
 * Compare two HLC timestamps.
 * Returns: < 0 if a < b, 0 if equal, > 0 if a > b.
 */
export function compareHLC(a: HLC | undefined, b: HLC | undefined): number {
  if (!a) return -1;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

/** Generate a new HLC timestamp for the server. */
export function newServerHLC(lastHLC?: HLC | null): HLC {
  const now = Date.now();
  const deviceId = "server";

  if (!lastHLC || now > lastHLC.timestamp) {
    return { timestamp: now, counter: 0, deviceId };
  }

  // Same timestamp — increment counter.
  return {
    timestamp: lastHLC.timestamp,
    counter: lastHLC.counter + 1,
    deviceId,
  };
}
