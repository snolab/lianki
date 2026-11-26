/** Defaults are registered in lib/config.ts; live values arrive through cfg/publicCfg. */
export const DICTATION_POLICY_DEFAULTS = {
  beatMs: 20_000,
  leaseMs: 60_000,
  pendingMs: 600_000,
  maxQueued: 50,
  maxRoutes: 32,
  maxReceipts: 1024,
  requestsPerMinute: 180,
};
export type DictationPolicyValues = typeof DICTATION_POLICY_DEFAULTS;
/** Reject corrupt values together; the heartbeat must fit inside the target lease. */
export function dictationPolicy(value: unknown): DictationPolicyValues {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return { ...DICTATION_POLICY_DEFAULTS };
  const bounds: Record<keyof DictationPolicyValues, [number, number]> = {
    beatMs: [1000, 20000], leaseMs: [60000, 300000], pendingMs: [60000, 600000],
    maxQueued: [1, 50], maxRoutes: [1, 128], maxReceipts: [50, 4096],
    requestsPerMinute: [10, 600],
  };
  for (const k of Object.keys(bounds) as (keyof DictationPolicyValues)[]) {
    const n = v[k], [min, max] = bounds[k];
    if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max) return { ...DICTATION_POLICY_DEFAULTS };
  }
  return {
    beatMs: Number(v.beatMs), leaseMs: Number(v.leaseMs), pendingMs: Number(v.pendingMs),
    maxQueued: Number(v.maxQueued), maxRoutes: Number(v.maxRoutes), maxReceipts: Number(v.maxReceipts),
    requestsPerMinute: Number(v.requestsPerMinute),
  };
}
