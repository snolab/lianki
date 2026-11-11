// Lightweight turn assembly before a heavy assistant is awakened.
import { createHash } from "node:crypto";
export const TURN_DEFAULTS = { quietMs: 1200, maxWaitMs: 6000, maxParts: 24, maxChars: 6000, maxEchoes: 64, echoTtlMs: 60000 };
export function turnConfig(env = {}) {
  return Object.fromEntries(Object.entries(TURN_DEFAULTS).map(([key, fallback]) => {
    const name = `LIANKI_CHAT_TURN_${key.replace(/[A-Z]/g, (s) => `_${s}`).toUpperCase()}`;
    const n = Number(env[name]);
    return [key, Number.isSafeInteger(n) && n > 0 ? Math.min(n, fallback) : fallback];
  }));
}

const urgent = (s) => /^(?:(?:codex|claude|agy|小可|linky)[,，:：\s]*)?(?:(?:please|请|马上|立即)\s*)?(?:停止|取消|先停一下|停一下|停下|别做了|不要继续|撤销|やめて|中止|(?:stop|cancel|abort|never mind)\b)/iu.test(s.trim());

/** @param {{bridge: any, prepare?: (input: any) => Promise<any>, config?: Record<string, number>, now?: () => number, requestId: () => string, report?: (event: any) => void, onError?: (error: any) => void, polish?: (turn: any, suggestion: string) => Promise<any>}} options */
export function createChatReceiver({ bridge, prepare, config = {}, now = Date.now, requestId, report = () => {}, onError = () => {}, polish }) {
  const cfg = { ...TURN_DEFAULTS, ...config };
  const known = new Map();
  let scope = "owner";
  let turn;
  let quiet;
  let maximum;
  let generation = 0;
  let cancelEpoch = 0;
  let boundary = 0;
  let flushing;
  const tasks = new Set();
  const context = [];
  const expectedPolish = new Map();
  const inScope = (m) => scope === "own" || (m.thread ?? scope) === scope;
  const remember = (m) => {
    known.set(m.id, m);
    if (known.size > 256) known.delete(known.keys().next().value);
    const at = context.findIndex((x) => x.id === m.id);
    if (at >= 0) context.splice(at, 1);
    context.push({ id: m.id, from: m.from, text: m.text.slice(0, 2000) });
    if (context.length > 12) context.shift();
  };
  const clear = () => { clearTimeout(quiet); clearTimeout(maximum); quiet = maximum = undefined; };
  const tracked = (promise) => {
    tasks.add(promise);
    void promise.then(() => tasks.delete(promise), (e) => { tasks.delete(promise); onError(e); });
    return promise;
  };
  function flush(force = false) {
    if (flushing) return flushing.then(() => flush(force));
    const job = doFlush(force);
    flushing = job;
    return job.finally(() => { if (flushing === job) flushing = undefined; });
  }
  async function doFlush(force = false) {
    if (!turn) return;
    clear();
    const batch = turn;
    const version = generation;
    const cancellation = cancelEpoch;
    const messages = [...batch.messages.values()];
    const text = messages.map((m) => m.text).join("\n");
    let verdict = { action: "forward", turn: "uncertain", reason: "unavailable" };
    if (batch.checkedText === text) verdict = batch.verdict;
    else if (prepare) {
      try { verdict = await prepare({ v: 1, requestId: requestId(), text, context: batch.context }); }
      catch { report({ type: "prepare-unavailable" }); }
    }
    // New speech or a cancellation invalidates an older model response.
    if (turn !== batch || generation !== version) return;
    batch.checkedText = text; batch.verdict = verdict;
    if (!force && verdict.turn === "continue" && now() - batch.started < cfg.maxWaitMs) {
      maximum = setTimeout(() => tracked(flush(true)), Math.max(1, cfg.maxWaitMs - (now() - batch.started)));
      return;
    }
    turn = undefined;
    if (verdict.action === "ignore" && verdict.confidence === "high" && ["household", "background", "unrelated"].includes(verdict.reason)) {
      report({ type: "filtered-turn", ids: messages.map((m) => m.id), reason: verdict.reason });
      return;
    }
    const first = messages[0];
    const assembled = { ...first, text, raw: text, rawRevisions: batch.revisions, turnIds: messages.map((m) => m.id), turnComplete: true,
      ...(typeof verdict.polished === "string" ? { polished: verdict.polished, polishAuthority: "advisory; raw is authoritative" } : {}) };
    // A validated suggestion can be written only via a separately authorized adapter.
    if (polish && assembled.polished) {
      const expectation = { text: assembled.polished, ids: assembled.turnIds, rawFingerprint: createHash("sha256").update(JSON.stringify(batch.revisions)).digest("hex"), at: now() };
      expectedPolish.set(first.id, expectation);
      if (expectedPolish.size > cfg.maxEchoes) expectedPolish.delete(expectedPolish.keys().next().value);
      // The raw instruction is ready now; UI acknowledgement must not delay it.
      void Promise.resolve().then(() => cancellation === cancelEpoch ? polish(assembled, assembled.polished) : undefined).catch(() => {
        if (expectedPolish.get(first.id) === expectation) expectedPolish.delete(first.id);
        report({ type: "polish-refused", ids: assembled.turnIds });
      });
    }
    if (cancelEpoch !== cancellation) return;
    await bridge.accept({ type: "chat", message: assembled });
  }
  function schedule() {
    clear();
    const left = Math.max(1, cfg.maxWaitMs - (now() - turn.started));
    quiet = setTimeout(() => tracked(flush(false)), Math.min(cfg.quietMs, left));
    maximum = setTimeout(() => tracked(flush(true)), left);
  }
  return {
    async accept(event) {
      for (const [id, item] of expectedPolish) if (now() - item.at >= cfg.echoTtlMs) expectedPolish.delete(id);
      if (event.type === "ready") { scope = event.thread ?? scope; return bridge.accept(event); }
      if (event.type === "history" || event.history) {
        const list = event.type === "history" ? event.messages ?? [] : [event.message ?? event];
        for (const m of list) if (typeof m.id === "string" && typeof m.text === "string" && inScope(m)) remember(m);
        return bridge.accept(event);
      }
      const raw = event.type === "chat" ? event.message ?? event : event.type === "edited" ? event : null;
      if (!raw || typeof raw.text !== "string" || typeof raw.id !== "string") {
        if (event.type === "answered") { generation++; cancelEpoch++; turn = undefined; clear(); }
        return bridge.accept(event);
      }
      if (event.type === "edited" && (raw.restored || raw.split)) {
        if (turn?.messages.has(raw.id)) {
          const ids = new Set([raw.id, ...(raw.restored ?? raw.split ?? []).map((x) => x.id)]);
          generation++;
          for (const id of ids) turn.messages.delete(id);
          turn.revisions = turn.revisions.filter((x) => !ids.has(x.id));
          if (!turn.messages.size) { turn = undefined; clear(); }
          else schedule();
        }
        expectedPolish.delete(raw.id);
        known.set(raw.id, { ...known.get(raw.id), ...raw });
        return;
      }
      const expected = expectedPolish.get(raw.id);
      if (event.type === "edited" && expected?.text === raw.text &&
        (expected.ids.length === 1 || JSON.stringify(raw.passage?.ids) === JSON.stringify(expected.ids))) {
        known.set(raw.id, { ...known.get(raw.id), ...raw });
        return;
      }
      const m = event.type === "edited" ? { ...known.get(raw.id), ...raw } : raw;
      if (!inScope(m)) return;
      if (m.from === "agent") {
        // An assistant reply is a hard boundary: never join speech across it.
        boundary++;
        await flush(true);
        remember(m);
        return bridge.accept(event);
      }
      if (!["owner", "friend", "user"].includes(m.from)) return;
      if (known.get(m.id)?.text === m.text) return;
      remember(m);
      if (urgent(m.text)) {
        generation++;
        cancelEpoch++;
        const canceled = turn?.revisions;
        turn = undefined; clear();
        return bridge.accept({ type: "chat", message: { ...m, ...(canceled ? { canceledRawRevisions: canceled } : {}) } });
      }
      if (m.source !== "stt" || m.context || m.attachments?.length) {
        boundary++;
        await flush(true);
        return bridge.accept({ type: event.type, ...(event.type === "chat" ? { message: m } : m) });
      }
      if (turn && (turn.boundary !== boundary || turn.messages.size >= cfg.maxParts || [...turn.messages.values()].reduce((n, x) => n + x.text.length, 0) + m.text.length > cfg.maxChars || turn.to !== m.to || turn.thread !== m.thread)) await flush(true);
      if (!turn) turn = { started: now(), boundary, messages: new Map(), revisions: [], context: context.slice(0, -1).slice(-6).map(({ from, text }) => ({ from, text: text.slice(0, 500) })), to: m.to, thread: m.thread };
      generation++;
      turn.messages.set(m.id, m);
      turn.revisions.push({ id: m.id, text: m.text, raw: m.raw, at: m.at });
      if (turn.revisions.length > cfg.maxParts) await flush(true);
      else schedule();
    },
    async finish() { await flush(true); await Promise.all(tasks); },
    stop() { generation++; cancelEpoch++; turn = undefined; clear(); },
  };
}
