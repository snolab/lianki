type RateLimitState = {
  count: number;
  resetAt: number;
};

type RateLimitStore = Map<string, RateLimitState>;

type RateLimitOptions = {
  windowMs: number;
  max: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

const MAX_STORE_SIZE = 5000;

const globalStore = globalThis as typeof globalThis & {
  __liankiRateLimitStore?: RateLimitStore;
};

function getStore(): RateLimitStore {
  if (!globalStore.__liankiRateLimitStore) {
    globalStore.__liankiRateLimitStore = new Map<string, RateLimitState>();
  }
  return globalStore.__liankiRateLimitStore;
}

function cleanupExpiredEntries(store: RateLimitStore, now: number) {
  for (const [key, state] of store.entries()) {
    if (state.resetAt <= now) {
      store.delete(key);
    }
  }

  // Prevent unbounded growth if many unique keys hit a single runtime.
  if (store.size <= MAX_STORE_SIZE) return;

  const sorted = [...store.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  const overflow = sorted.length - MAX_STORE_SIZE;
  for (let i = 0; i < overflow; i += 1) {
    store.delete(sorted[i][0]);
  }
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const store = getStore();
  cleanupExpiredEntries(store, now);

  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + options.windowMs;
    store.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: Math.max(0, options.max - 1),
      retryAfterMs: options.windowMs,
    };
  }

  existing.count += 1;
  const allowed = existing.count <= options.max;
  return {
    allowed,
    remaining: Math.max(0, options.max - existing.count),
    retryAfterMs: Math.max(0, existing.resetAt - now),
  };
}
