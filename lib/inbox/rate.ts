/** Per-account, per-isolate upload limit: another account never spends your window. */
export function createAccountUploadLimiter(now: () => number = Date.now) {
  const windowMs = 60_000;
  const entries = new Map<string, { until: number; count: number }>();
  let pruned = -Infinity;
  return (account: string, max: number): boolean => {
    if (!account || max < 1) return false;
    const t = now();
    if (t - pruned >= windowMs) {
      for (const [id, entry] of entries) if (entry.until <= t) entries.delete(id);
      pruned = t;
    }
    let entry = entries.get(account);
    if (!entry || entry.until <= t) {
      entry = { until: t + windowMs, count: 0 };
      entries.set(account, entry);
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}
