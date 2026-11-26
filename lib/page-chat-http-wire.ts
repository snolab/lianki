/** Browser-safe wire contract. No API token or ticket is ever part of a client response. */
import { MAX_CHAT, type ChatReplayRange } from "../packages/debug-chat/src/wire";
import {
  parseDictationRoute,
  parseDictationSelector,
  type DictationRoute,
  type DictationSelector,
  type DictationRange,
} from "../packages/debug-chat/src/dictation-wire";
export const PAGE_CHAT_HTTP_PATH = "/api/chat/page-broker";
export const PAGE_CHAT_HTTP_INTERNAL_PATH = "/internal/page-chat";
export const PAGE_CHAT_HTTP_HEADER = "x-lianki-page-chat-capability";
export const PAGE_CHAT_PRINCIPAL_HEADER = "x-lianki-chat-principal";
export const PAGE_CHAT_HTTP_MAX_BYTES = 32768;
export const PAGE_CHAT_HTTP_WAIT_MS = 20000;
export type PageChatHttpInput =
  | { op: "hello" }
  | { op: "read"; afterSeq?: number; wait: boolean; dictation?: DictationSelector }
  | DictationRoute
  | { op: "send"; id: string; text: string };
export type PageChatHttpAction = Exclude<PageChatHttpInput, { op: "hello" }>;
export type PageChatHttpError =
  | "invalid"
  | "too-large"
  | "off"
  | "signed-out"
  | "account-changed"
  | "blocked"
  | "rate-limited"
  | "busy"
  | "unavailable"
  | "cancelled"
  | "id-conflict"
  | "no-grant"
  | "stale";
export type PageChatHttpResult =
  | { ok: false; error: PageChatHttpError; gen?: number }
  | { ok: true; kind: "hello"; principal: string }
  | { ok: true; kind: "accepted"; id: string; seq: number }
  | { ok: true; kind: "route"; state: "listening" | "no-source" | "off"; gen: number }
  | {
      ok: true;
      kind: "history";
      range: ChatReplayRange & { dictation?: DictationRange };
      pending?: string;
      warning?: "no-reply" | "limit";
    };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
/** Reject extra operations/authority fields, rather than silently forwarding them. */
export function parsePageChatHttpInput(value: unknown): PageChatHttpInput | null {
  if (!object(value)) return null;
  if (value.op === "hello") return exactKeys(value, ["op"]) ? { op: "hello" } : null;
  if (value.op === "route") return parseDictationRoute(value);
  if (value.op === "read") {
    const dictation =
      value.dictation === undefined ? undefined : parseDictationSelector(value.dictation);
    if (
      !exactKeys(value, ["op", "afterSeq", "wait", "dictation"]) ||
      dictation === null ||
      (value.afterSeq !== undefined &&
        (!Number.isSafeInteger(value.afterSeq) || Number(value.afterSeq) < 0)) ||
      (value.wait !== undefined && typeof value.wait !== "boolean")
    )
      return null;
    return {
      op: "read",
      ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq as number }),
      wait: value.wait === true,
      ...(dictation === undefined ? {} : { dictation }),
    };
  }
  if (value.op === "send") {
    if (
      !exactKeys(value, ["op", "id", "text"]) ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(value.id) ||
      typeof value.text !== "string"
    )
      return null;
    const text = value.text.trim();
    return text && text.length <= MAX_CHAT ? { op: "send", id: value.id, text } : null;
  }
  return null;
}
/** Bound actual streamed bytes, including requests without Content-Length. */
export async function readPageChatHttpInput(
  request: Request,
): Promise<PageChatHttpInput | "too-large" | null> {
  const claimed = request.headers.get("content-length");
  if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > PAGE_CHAT_HTTP_MAX_BYTES))
    return "too-large";
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PAGE_CHAT_HTTP_MAX_BYTES) {
        await reader.cancel();
        return "too-large";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parsePageChatHttpInput(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
