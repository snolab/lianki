/** Interactive local consent. Never sends Li credentials or exposes a management key. */
import { liveTicket, type LiveTicket } from "@lianki/debug-chat/live-audio-core";
const BASE = "http://127.0.0.1:13775";
const FORMAT = { sampleRate: 16000, channels: 1, format: "s16le" } as const;
export type VoicePairState =
  | "requesting"
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "unavailable";
export type ApprovedVoiceChat = { title: string; origin: string };
export type VoicePairResult = { ticket: LiveTicket; chat: ApprovedVoiceChat };
const fail = () => {
  throw Error("voice-connection-unavailable");
};
const endpoint = (raw: unknown, path: string, base = BASE) => {
  if (typeof raw !== "string") return fail();
  const url = new URL(raw);
  if (
    url.origin !== base ||
    url.pathname !== path ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    return fail();
  return url.href;
};
async function json(response: Response): Promise<any> {
  if (!response.ok || !response.body) return fail();
  const reader = response.body.getReader();
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) return fail();
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(Error("cancelled"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function requestVoicePair(d: {
  origin: string;
  sourceId: string;
  /** Isolated test gateway only; the UI never accepts a base from URL/storage. */
  base?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  deadline?: (ms: number) => AbortSignal;
  pause?: (signal: AbortSignal) => Promise<void>;
  changed(state: VoicePairState, approvalUrl?: string): void;
}) {
  const base = d.base ?? BASE;
  const request = d.fetch ?? fetch,
    now = d.now ?? Date.now;
  const abort = new AbortController();
  const deadline = (ms: number) => (d.deadline ? d.deadline(ms) : AbortSignal.timeout(ms));
  let revoked = false;
  let cancelled = false,
    settled = false;
  let receipt: { requestId: string; requestNonce: string; cancelUrl: string } | null = null;
  const send = (url: string, body?: unknown, cancel = false) =>
    request(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: cancel
        ? deadline(5000)
        : AbortSignal.any([abort.signal, deadline(body === undefined ? 120000 : 5000)]),
      ...(cancel ? { keepalive: true } : {}),
    });
  const revoke = () => {
    if (!receipt || revoked) return;
    revoked = true;
    const { requestId, requestNonce, cancelUrl } = receipt;
    void send(cancelUrl, { requestId, requestNonce }, true).catch(() => {});
  };
  const ready = (async (): Promise<VoicePairResult> => {
    try {
      const origin = new URL(d.origin);
      if (
        origin.origin !== d.origin ||
        (origin.protocol !== "https:" &&
          !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))
      )
        return fail();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(d.sourceId)) return fail();
      if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(base) || new URL(base).origin !== base)
        return fail();
      d.changed("requesting");
      const discovery = await json(await send(base + "/audio/pair/discovery"));
      if (discovery.version !== 2) return fail();
      const requestUrl = endpoint(discovery.requestUrl, "/audio/pair/request", base);
      const pending = await json(
        await send(requestUrl, {
          sourceId: d.sourceId,
          destinationId: null,
          input: FORMAT,
          output: FORMAT,
          frameMs: 20,
        }),
      );
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          pending.requestId,
        ) ||
        !/^[A-Za-z0-9_-]{43}$/.test(pending.requestNonce)
      )
        return fail();
      receipt = {
        requestId: pending.requestId,
        requestNonce: pending.requestNonce,
        cancelUrl: endpoint(pending.cancelUrl, "/audio/pair/cancel", base),
      };
      const statusUrl = endpoint(pending.statusUrl, "/audio/pair/status", base);
      const approval = new URL(pending.approvalUrl);
      if (
        approval.origin !== base ||
        approval.pathname !== "/audio/pair/approve" ||
        approval.username ||
        approval.password ||
        approval.hash ||
        approval.search !== "?requestId=" + pending.requestId
      )
        return fail();
      if (
        !Number.isFinite(pending.expiresAt) ||
        pending.expiresAt <= now() ||
        pending.expiresAt > now() + 120000
      )
        return fail();
      if (cancelled) throw Error("cancelled");
      d.changed("pending", approval.href);
      while (!cancelled && now() < pending.expiresAt) {
        const status = await json(
          await send(statusUrl, {
            requestId: receipt.requestId,
            requestNonce: receipt.requestNonce,
          }),
        );
        if (cancelled) throw Error("cancelled");
        if (status.state === "approved") {
          const ticket = liveTicket(status.ticket, d.origin, now());
          if (
            ticket.sourceId !== d.sourceId ||
            !status.approvedChat ||
            typeof status.approvedChat.title !== "string" ||
            !status.approvedChat.title.trim() ||
            status.approvedChat.title.length > 512
          )
            return fail();
          const chatOrigin = new URL(status.approvedChat.origin);
          if (
            !["https:", "http:"].includes(chatOrigin.protocol) ||
            chatOrigin.origin !== status.approvedChat.origin
          )
            return fail();
          settled = true;
          d.changed("approved");
          return { ticket, chat: { title: status.approvedChat.title, origin: chatOrigin.origin } };
        }
        if (["denied", "expired", "cancelled"].includes(status.state)) {
          settled = true;
          d.changed(status.state);
          throw Error(status.state);
        }
        if (status.state !== "pending") return fail();
        await (d.pause ?? pause)(abort.signal);
      }
      if (cancelled) throw Error("cancelled");
      settled = true;
      d.changed("expired");
      throw Error("expired");
    } catch (error) {
      revoke();
      if (!settled && !cancelled) d.changed("unavailable");
      throw error;
    }
  })();
  return {
    ready,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      revoke();
      d.changed("cancelled");
    },
  };
}
