/** Confirm the announced build at this origin before an automatic reload. */
import { parseFingerprints } from "./smart-refresh";

export const VERSION_PROBE_TIMEOUT_MS = 2500;
const RETRY_DELAYS = [100, 200, 400, 800] as const;
type Schedule = (callback: () => void, delay: number) => () => void;
const schedule: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** One immediate request, bounded backoff, and cancellation even during response.json(). */
export function probeVersion({
  build,
  ready,
  unavailable,
  fetcher = fetch,
  later = schedule,
  now = Date.now,
}: {
  build: string;
  ready: () => void;
  unavailable: () => void;
  fetcher?: typeof fetch;
  later?: Schedule;
  now?: () => number;
}): () => void {
  const controller = new AbortController();
  const deadline = now() + VERSION_PROBE_TIMEOUT_MS;
  let active = true;
  let attempt = 0;
  let cancelRetry = () => {};
  let cancelDeadline = () => {};
  const finish = (result?: boolean) => {
    if (!active) return;
    active = false;
    cancelRetry();
    cancelDeadline();
    controller.abort();
    if (result === true && now() >= deadline) result = false;
    if (result === true) ready();
    else if (result === false) unavailable();
  };
  const nonce = Date.now();
  const check = async () => {
    if (!active) return;
    if (now() >= deadline) return finish(false);
    try {
      const response = await fetcher(`/_lk/route-fp.json?_lk_probe=${nonce}-${attempt}`, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (active && response.ok && parseFingerprints(await response.json())?.build === build) {
        if (active) finish(true);
      }
    } catch {
      // Rollout errors, offline responses and malformed files all use the same bounded retry.
    }
    if (active) {
      if (now() >= deadline) return finish(false);
      const delay = RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)]!;
      cancelRetry = later(() => void check(), delay);
    }
  };
  cancelDeadline = later(() => finish(false), VERSION_PROBE_TIMEOUT_MS);
  void check();
  return () => finish();
}
