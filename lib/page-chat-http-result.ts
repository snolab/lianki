/** Copy the narrow public response instead of forwarding arbitrary internal fields. */
import type { ChatMessage, ChatReplayRange } from "../packages/debug-chat/src/wire";
import type { PageChatHttpResult } from "./page-chat-http-wire";
const errors = new Set([
  "invalid",
  "too-large",
  "off",
  "signed-out",
  "account-changed",
  "blocked",
  "rate-limited",
  "busy",
  "unavailable",
  "cancelled",
  "id-conflict",
]);
export function publicPageChatResult(value: unknown): PageChatHttpResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.ok === false && typeof v.error === "string" && errors.has(v.error))
    return { ok: false, error: v.error as Extract<PageChatHttpResult, { ok: false }>["error"] };
  if (v.ok !== true) return null;
  if (
    v.kind === "accepted" &&
    typeof v.id === "string" &&
    /^[A-Za-z0-9_-]{8,64}$/.test(v.id) &&
    Number.isSafeInteger(v.seq) &&
    Number(v.seq) > 0
  )
    return { ok: true, kind: "accepted", id: v.id, seq: v.seq as number };
  if (v.kind === "history" && v.range && typeof v.range === "object") {
    const r = v.range as ChatReplayRange;
    if (
      r.type !== "history" ||
      typeof r.thread !== "string" ||
      ![r.afterSeq, r.throughSeq, r.headSeq, r.prunedThroughSeq].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      !Array.isArray(r.messages) ||
      r.messages.length > 500 ||
      !Array.isArray(r.removed) ||
      r.removed.length > 500 ||
      !Array.isArray(r.skipped) ||
      r.skipped.length > 500
    )
      return null;
    const messages: ChatMessage[] = [];
    for (const m of r.messages) {
      if (
        !m ||
        typeof m.id !== "string" ||
        m.id.length > 128 ||
        typeof m.text !== "string" ||
        m.text.length > 64000 ||
        !["owner", "friend", "agent"].includes(m.from) ||
        !Number.isFinite(m.at) ||
        !Number.isSafeInteger(m.seq) ||
        Number(m.seq) < 1
      )
        return null;
      messages.push({
        id: m.id,
        text: m.text,
        from: m.from,
        at: m.at,
        seq: m.seq,
        label: "",
        thread: r.thread,
      });
    }
    const removed = r.removed.map((x) => ({ id: x.id, seq: x.seq }));
    if (
      !removed.every(
        (x) =>
          typeof x.id === "string" &&
          x.id.length <= 128 &&
          Number.isSafeInteger(x.seq) &&
          x.seq > 0,
      )
    )
      return null;
    const skipped = r.skipped.map((x) => ({ from: x.from, to: x.to }));
    if (
      !skipped.every(
        (x) =>
          Number.isSafeInteger(x.from) &&
          Number.isSafeInteger(x.to) &&
          x.from >= 0 &&
          x.to >= x.from,
      )
    )
      return null;
    return {
      ok: true,
      kind: "history",
      range: {
        type: "history",
        thread: r.thread,
        messages,
        removed,
        skipped,
        afterSeq: r.afterSeq,
        throughSeq: r.throughSeq,
        headSeq: r.headSeq,
        prunedThroughSeq: r.prunedThroughSeq,
      },
      ...(typeof v.pending === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v.pending)
        ? { pending: v.pending }
        : {}),
      ...(v.warning === "no-reply" || v.warning === "limit" ? { warning: v.warning } : {}),
    };
  }
  return null;
}
