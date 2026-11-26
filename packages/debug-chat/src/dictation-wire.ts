/** Narrow text-only routing protocol. No audio, credentials, page content or chat-send operation. */
import { MAX_CHAT } from "./wire";

export const DICTATION_BATCH_MAX = 50;
export type DictationRoute =
  | { op: "route"; state: "on"; bid: string; routeId: string }
  | { op: "route"; state: "beat" | "off"; bid: string; routeId: string; gen: number };
export type DictationSelector = { bid: string; routeId: string; gen: number; afterSeq?: number };
export type DictationRange = {
  routeId: string;
  gen: number;
  throughSeq: number;
  items: { seq: number; finalId: string; text: string; at: number }[];
};
export type DictationTarget = { origin: string; routeId: string; gen: number };
export type DictationFinal = {
  type: "chat-dictation";
  bid: string;
  routeId: string;
  gen: number;
  sgen: number;
  finalId: string;
  text: string;
  at: number;
};
export type DictationPageMessage =
  | { type: "dictation-source"; bid: string; state: "on" | "off" }
  | { type: "dictation-stop"; bid: string }
  | DictationFinal;
export type DictationReturnReason = "rejected" | "target-changed" | "revoked" | "expired" | "gone" | "full";
export type DictationHubMessage =
  | { type: "dictation-source-ok"; bid: string; sgen: number; principal: string }
  | { type: "dictation-target"; bid: string; target: DictationTarget | null }
  | { type: "dictation-acked"; finalIds: string[] }
  | { type: "dictation-returned"; finalIds: string[]; why: DictationReturnReason }
  | { type: "dictation-unconfirmed"; finalIds: string[]; why: Exclude<DictationReturnReason, "rejected" | "full"> };

export const dictationInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const dictationId = (v: unknown, min = 8): v is string =>
  typeof v === "string" && v.length >= min && v.length <= 64 && !/[^A-Za-z0-9_-]/.test(v);
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[], required = allowed) =>
  Object.keys(v).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(v, k));

export function parseDictationRoute(v: unknown): DictationRoute | null {
  if (!rec(v) || v.op !== "route" || !dictationId(v.bid, 16) || !dictationId(v.routeId)) return null;
  if (v.state === "on" && keys(v, ["op", "state", "bid", "routeId"]))
    return { op: "route", state: "on", bid: v.bid, routeId: v.routeId };
  if ((v.state === "beat" || v.state === "off") && keys(v, ["op", "state", "bid", "routeId", "gen"]) && dictationInteger(v.gen))
    return { op: "route", state: v.state, bid: v.bid, routeId: v.routeId, gen: v.gen };
  return null;
}
export function parseDictationSelector(v: unknown): DictationSelector | null {
  if (!rec(v) || !keys(v, ["bid", "routeId", "gen", "afterSeq"], ["bid", "routeId", "gen"]) ||
    !dictationId(v.bid, 16) || !dictationId(v.routeId) || !dictationInteger(v.gen) ||
    (v.afterSeq !== undefined && !dictationInteger(v.afterSeq))) return null;
  return { bid: v.bid, routeId: v.routeId, gen: v.gen, ...(v.afterSeq === undefined ? {} : { afterSeq: v.afterSeq }) };
}
export function parseDictationPageMessage(v: unknown): DictationPageMessage | null {
  if (!rec(v) || !dictationId(v.bid, 16)) return null;
  if (v.type === "dictation-source" && keys(v, ["type", "bid", "state"]) && (v.state === "on" || v.state === "off"))
    return { type: v.type, bid: v.bid, state: v.state };
  if (v.type === "dictation-stop" && keys(v, ["type", "bid"])) return { type: v.type, bid: v.bid };
  if (v.type === "chat-dictation" && keys(v, ["type", "bid", "routeId", "gen", "sgen", "finalId", "text", "at"]) &&
    dictationId(v.routeId) && dictationId(v.finalId) && dictationInteger(v.gen) && dictationInteger(v.sgen) &&
    dictationInteger(v.at) && typeof v.text === "string" && !!v.text.trim() && v.text.length <= MAX_CHAT)
    return { type: v.type, bid: v.bid, routeId: v.routeId, gen: v.gen, sgen: v.sgen, finalId: v.finalId, text: v.text, at: v.at };
  return null;
}
/** Copy only a bounded public range. Unknown upstream fields never ride to a host page. */
export function publicDictationRange(v: unknown): DictationRange | null {
  if (!rec(v) || !dictationId(v.routeId) || !dictationInteger(v.gen) || !dictationInteger(v.throughSeq) ||
    !Array.isArray(v.items) || v.items.length > DICTATION_BATCH_MAX) return null;
  const items: DictationRange["items"] = [];
  let previous = 0;
  const ids = new Set<string>();
  for (const item of v.items) {
    if (!rec(item) || !dictationInteger(item.seq) || item.seq <= previous || item.seq > v.throughSeq ||
      !dictationId(item.finalId) || ids.has(item.finalId) || !dictationInteger(item.at) ||
      typeof item.text !== "string" || !item.text.trim() || item.text.length > MAX_CHAT) return null;
    items.push({ seq: item.seq, finalId: item.finalId, text: item.text, at: item.at });
    ids.add(item.finalId);
    previous = item.seq;
  }
  return { routeId: v.routeId, gen: v.gen, throughSeq: v.throughSeq, items };
}
