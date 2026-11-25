/** Content-free marks on one browser clock; no inferred request/reply pairing. */
export type MessageTiming = {
  id: string;
  source?: "typed" | "stt";
  from?: "owner" | "friend" | "agent";
  lane?: string;
  sentAt?: number;
  receivedAt?: number;
  displayedAt?: number;
  speechStartedAt?: number;
  speechEndedAt?: number;
  speechStoppedAt?: number;
  speechOutcome?: "playing" | "ended" | "error" | "cancelled";
};

export type MessageTimingBatch = {
  ev: "chat-message-timing";
  clock: "client";
  /** Random per enabled page session; never persisted or derived from an account/device. */
  pageInstance: string;
  records: MessageTiming[];
};

export type MessageTelemetryConfig = {
  sampleRate: number;
  flushMs: number;
  batchSize: number;
  log: ((event: MessageTimingBatch) => void) | null;
};

const safeId = (s: string) =>
  typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s) && !/lk_/i.test(s);
const safeLane = (s: unknown): s is string =>
  typeof s === "string" && /^[\p{L}\p{N}_-]{1,64}$/u.test(s) && !/lk_/i.test(s);
const timestamp = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e14;

/** Updates of one message always have the same sampling decision. */
export function sampledMessage(id: string, rate: number): boolean {
  if (!safeId(id) || !Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296 < rate;
}

export function createMessageTelemetry(d: {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  maxRecords?: number;
  instanceId?: () => string;
} = {}) {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const capacity = Math.max(1, Math.min(512, Math.floor(d.maxRecords ?? 128) || 128));
  const records = new Map<string, MessageTiming>();
  const dirty = new Set<string>();
  let config: MessageTelemetryConfig = { sampleRate: 0, flushMs: 10000, batchSize: 8, log: null };
  let timer: unknown;
  let scheduled = false;
  let pageInstance: string | undefined;
  const cancelTimer = () => {
    if (scheduled) clearTimer(timer);
    scheduled = false;
    timer = undefined;
  };
  const flush = () => {
    cancelTimer();
    const log = config.log;
    const instance = pageInstance;
    if (!log || !instance || !dirty.size) return;
    const pending = [...dirty];
    dirty.clear();
    let batch: MessageTiming[] = [];
    const send = () => {
      if (!batch.length) return;
      try {
        log({ ev: "chat-message-timing", clock: "client", pageInstance: instance, records: batch });
      } catch {
        // Diagnostics never affect sending/rendering/playback; no retry loop.
      }
      batch = [];
    };
    for (const id of pending) {
      const record = records.get(id);
      if (!record || !sampledMessage(id, config.sampleRate)) continue;
      const copy = { ...record };
      // The existing dev-log request cap is 8192 characters. Reserve room for
      // its envelope and split large batches; only allowlisted fields enter.
      if (batch.length && (batch.length >= config.batchSize || JSON.stringify([...batch, copy]).length > 6000)) send();
      batch.push(copy);
    }
    send();
  };
  const changed = (id: string) => {
    if (!sampledMessage(id, config.sampleRate)) return;
    dirty.add(id);
    if (dirty.size >= config.batchSize) return flush();
    if (!scheduled) {
      scheduled = true;
      timer = setTimer(flush, config.flushMs);
    }
  };
  const get = (id: string, create = true) => {
    if (!config.log || !safeId(id)) return;
    let record = records.get(id);
    if (!record && create) {
      while (records.size >= capacity) {
        const oldest = records.keys().next().value!;
        records.delete(oldest);
        dirty.delete(oldest);
      }
      record = { id };
      records.set(id, record);
    }
    return record;
  };
  return {
    configure(next: Partial<MessageTelemetryConfig>) {
      cancelTimer();
      config = {
        sampleRate: Number.isFinite(next.sampleRate) ? Math.max(0, Math.min(1, next.sampleRate!)) : config.sampleRate,
        flushMs: Number.isFinite(next.flushMs) ? Math.max(1, Math.min(300000, Math.floor(next.flushMs!))) : config.flushMs,
        batchSize: Number.isFinite(next.batchSize) ? Math.max(1, Math.min(32, Math.floor(next.batchSize!))) : config.batchSize,
        log: next.log === undefined ? config.log : next.log,
      };
      if (!config.log) {
        records.clear();
        dirty.clear();
        pageInstance = undefined;
      } else {
        // Rotate after account/scope cleanup, but not on routine configuration
        // changes. No identifier is written to storage or attached to messages.
        if (!pageInstance) pageInstance = d.instanceId?.() ?? crypto.randomUUID();
        if (dirty.size) {
          scheduled = true;
          timer = setTimer(flush, config.flushMs);
        }
      }
    },
    enabled: () => config.log !== null,
    sent(m: { id: string; source: "typed" | "stt"; at?: number }) {
      const r = get(m.id);
      const at = m.at ?? now();
      if (!r || r.sentAt !== undefined || !timestamp(at)) return;
      r.source = m.source === "stt" ? "stt" : "typed";
      r.sentAt = at;
      changed(m.id);
    },
    received(m: { id: string; from: "owner" | "friend" | "agent"; lane?: string; source?: "typed" | "stt"; at?: number }, live = true) {
      // Server `at` is another clock. History is not a new arrival.
      if (!live) return;
      const r = get(m.id);
      const at = now();
      if (!r || r.receivedAt !== undefined || !timestamp(at)) return;
      if (m.from === "owner" || m.from === "friend" || m.from === "agent") r.from = m.from;
      if (safeLane(m.lane)) r.lane = m.lane;
      if (m.source === "typed" || m.source === "stt") r.source = m.source;
      r.receivedAt = at;
      changed(m.id);
    },
    displayed(id: string) {
      const r = get(id, false);
      const at = now();
      if (!r || r.displayedAt !== undefined || !timestamp(at)) return;
      r.displayedAt = at;
      changed(id);
    },
    speech(id: string, event: "start" | "end" | "error" | "cancel") {
      const r = get(id, false);
      const at = now();
      if (!r || !timestamp(at)) return;
      if (event === "start") {
        if (r.speechStartedAt !== undefined || r.speechOutcome) return;
        r.speechStartedAt = at;
        r.speechOutcome = "playing";
      } else {
        // Only the first playback attempt is timed. A late callback cannot
        // turn a cancelled/error attempt into successful completion.
        if (r.speechOutcome && r.speechOutcome !== "playing") return;
        if (event === "end") {
          if (r.speechStartedAt === undefined) return;
          r.speechEndedAt = at;
          r.speechOutcome = "ended";
        } else {
          r.speechStoppedAt = at;
          r.speechOutcome = event === "error" ? "error" : "cancelled";
        }
      }
      changed(id);
    },
    flush,
    snapshot: () => [...records.values()].map((r) => ({ ...r })),
  };
}

export type MessageTelemetry = ReturnType<typeof createMessageTelemetry>;

/** Deployed and hot-loaded widgets share one store, without polling. */
export function messageTelemetry(): MessageTelemetry {
  const g = globalThis as typeof globalThis & { __lkMessageTelemetry?: MessageTelemetry };
  return (g.__lkMessageTelemetry ??= createMessageTelemetry());
}
