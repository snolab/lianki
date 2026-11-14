/**
 * Synchronized read-aloud (docs/li-sound-hub.md, "Synchronized read-aloud";
 * owner, 2026-11-14 20:2x JST): when two of his devices read Li's lines
 * aloud, they start the same line together. The faster device waits a few
 * milliseconds for the slower one to have it too.
 *
 * - Each page estimates its clock's offset to the hub NTP-style, over the
 *   chat socket: it sends {type:"clock", t0}; the hub answers {type:"clock",
 *   t0, t1, t2} (its receive and send times); the page notes t3 on arrival.
 *   offset = ((t1 − t0) + (t2 − t3)) / 2, the round trip (t3 − t0) − (t2 − t1).
 *   The samples with the lowest round trip are the ones kept and used.
 * - The hub stamps each agent line, and each edit (the read-back), with
 *   `speakAt` = hubNow + voice.syncLeadMs, only while ≥2 of his devices are
 *   connected and flag voice.sync-speak is on.
 * - A page that would start earlier than speakAt (in its own clock) waits; one
 *   already past it starts at once; never more than voice.syncMaxWaitMs.
 *
 * Pure apart from the clock store on globalThis (`__lkHubClock`), so a
 * hot-loaded copy of this module shares one estimate. Lines without
 * `speakAt` (an older hub, one device) and pages without an estimate (an older
 * hub never answers a clock ping) never wait. Tested in unit/sync-speak.test.ts.
 */

/** Feature flag (lib/flags.ts): the hub stamps lines with speakAt only while it is on. */
export const SYNC_SPEAK_FLAG = "voice.sync-speak";
/** Defaults of the config keys (lib/config.ts holds the live values). */
export const SYNC_LEAD_MS = 300;
export const SYNC_MAX_WAIT_MS = 1_500;
export const SYNC_SKEW_MS = 200;
/** Ping rounds sent per estimate (one after another's answer). */
export const CLOCK_ROUNDS = 4;
/** The lowest-RTT samples kept. */
export const CLOCK_KEEP = 4;
/** An estimate older than this is renewed by the next line that carries speakAt. */
export const CLOCK_REFRESH_MS = 10 * 60_000;
/** A sample with a round trip longer than this says nothing useful about the offset. */
export const CLOCK_MAX_RTT_MS = 5_000;

export type ClockSample = { offset: number; rtt: number; at: number };

/** One ping/pong round: hub clock minus local clock, and the network's share of the round trip. */
export function clockSample(t0: number, t1: number, t2: number, t3: number): ClockSample | null {
  if (![t0, t1, t2, t3].every(Number.isFinite)) return null;
  const rtt = t3 - t0 - (t2 - t1);
  if (rtt < 0 || rtt > CLOCK_MAX_RTT_MS) return null;
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt, at: t3 };
}

/** The samples to keep: the `keep` with the lowest round trip (newer first among equals). */
export function keepSamples(samples: readonly ClockSample[], keep = CLOCK_KEEP): ClockSample[] {
  return [...samples].sort((a, b) => a.rtt - b.rtt || b.at - a.at).slice(0, keep);
}

/**
 * The offset (hub − local, ms) from the samples: the lowest-RTT one's, since
 * its error is at most rtt/2. Null with none.
 */
export function estimateOffset(
  samples: readonly ClockSample[],
): { offset: number; rtt: number; at: number } | null {
  const best = keepSamples(samples, 1)[0];
  return best ? { offset: best.offset, rtt: best.rtt, at: best.at } : null;
}

/**
 * How long this page waits before reading a line stamped `speakAt` (hub ms):
 * until speakAt in its own clock, at most `maxWaitMs`; 0 when it is already
 * past, or with no speakAt or no offset estimate.
 */
export function syncWait(o: {
  speakAt?: unknown;
  offset: number | null | undefined;
  now: number;
  maxWaitMs?: number;
}): number {
  if (typeof o.speakAt !== "number" || !Number.isFinite(o.speakAt)) return 0;
  if (typeof o.offset !== "number" || !Number.isFinite(o.offset)) return 0;
  const wait = o.speakAt - o.offset - o.now;
  if (!(wait > 0)) return 0;
  return Math.min(wait, Math.max(0, o.maxWaitMs ?? SYNC_MAX_WAIT_MS));
}

/** His devices among the connected pages: distinct device ids (a page without one counts alone). */
export function syncDevices(pages: readonly { device?: string; id?: string }[]): number {
  const seen = new Set<string>();
  pages.forEach((p, i) => seen.add(p.device ? `d:${p.device}` : p.id ? `p:${p.id}` : `i:${i}`));
  return seen.size;
}

/** The ≥2 gate: a single device never waits, so its lines carry no speakAt. */
export const syncWanted = (devices: number): boolean => devices >= 2;

/** The hub's stamp for a line going out now, or undefined (gate closed, flag off). */
export function speakAtFor(o: {
  on: boolean;
  devices: number;
  hubNow: number;
  leadMs?: number;
}): number | undefined {
  if (!o.on || !syncWanted(o.devices)) return undefined;
  return o.hubNow + Math.max(0, o.leadMs ?? SYNC_LEAD_MS);
}

/** The hub side of a ping: its answer, or null for anything that is not one. */
export function clockPong(raw: unknown, hubNow: number) {
  if (typeof raw !== "string" || !raw.startsWith('{"type":"clock"')) return null;
  let m: { type?: unknown; t0?: unknown };
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (m.type !== "clock" || typeof m.t0 !== "number" || !Number.isFinite(m.t0)) return null;
  return { type: "clock" as const, t0: m.t0, t1: hubNow, t2: hubNow };
}

/** The page's view of the hub's clock: samples in, offset out. */
export type HubClock = {
  /** A ping to send now, or null while a round is already out. */
  ping(): { type: "clock"; t0: number } | null;
  /** A pong arrived: noted; true when another ping should follow (the round goes on). */
  pong(m: { t0?: unknown; t1?: unknown; t2?: unknown }): boolean;
  /** hub − local in ms, or null with no estimate yet. */
  offset(): number | null;
  /** No estimate, or an old one: the next speakAt line starts a new round. */
  stale(): boolean;
  /** A new socket: the old round is gone (its pong never comes); the samples stay. */
  reset(): void;
  samples(): readonly ClockSample[];
};

export function createHubClock(now: () => number = () => Date.now()): HubClock {
  let samples: ClockSample[] = [];
  let out: number | null = null;
  let left = 0;
  return {
    ping() {
      if (out !== null) return null;
      if (left <= 0) {
        // A new round: samples past the refresh age give way to the ones it brings.
        left = CLOCK_ROUNDS;
        samples = samples.filter((s) => now() - s.at <= CLOCK_REFRESH_MS);
      }
      out = now();
      return { type: "clock", t0: out };
    },
    pong(m) {
      if (out === null || m.t0 !== out) return false;
      out = null;
      const s = clockSample(m.t0 as number, Number(m.t1), Number(m.t2), now());
      if (s) samples = keepSamples([...samples, s]);
      left--;
      return left > 0;
    },
    offset: () => estimateOffset(samples)?.offset ?? null,
    stale() {
      if (!samples.length) return true;
      return now() - Math.max(...samples.map((s) => s.at)) > CLOCK_REFRESH_MS;
    },
    reset() {
      out = null;
      left = 0;
      // Old samples age out by the refresh: a fresh round replaces them as they come in.
      samples = samples.filter((s) => now() - s.at <= CLOCK_REFRESH_MS);
    },
    samples: () => samples,
  };
}

/** The page's one clock (shared by every copy of this module on the page). */
export function hubClock(): HubClock {
  const g = globalThis as { __lkHubClock?: HubClock };
  return (g.__lkHubClock ??= createHubClock());
}
