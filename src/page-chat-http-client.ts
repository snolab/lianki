/** Fixed GM transport. No arbitrary URL, Authorization, browser fetch or reusable credential. */
import {
  PAGE_CHAT_HTTP_PATH,
  PAGE_CHAT_PRINCIPAL_HEADER,
  parsePageChatHttpInput,
  type PageChatHttpInput,
  type PageChatHttpResult,
} from "../lib/page-chat-http-wire";
import { publicPageChatResult } from "../lib/page-chat-http-result";
import type { ChatGmRequest } from "./page-chat-fetch";
const origins = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);
export function pageChatHttpClient(origin: string, hostOrigin: string, request: ChatGmRequest) {
  return (
    input: PageChatHttpInput,
    principal?: string,
    signal?: AbortSignal,
  ): Promise<PageChatHttpResult> => {
    if (!origins.has(origin) || !parsePageChatHttpInput(input))
      return Promise.reject(new Error("invalid chat request"));
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve({ ok: false, error: "cancelled" });
        return;
      }
      let handle: unknown;
      let settled = false;
      const finish = (value: PageChatHttpResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        finish({ ok: false, error: "cancelled" });
        if (
          handle &&
          typeof handle === "object" &&
          "abort" in handle &&
          typeof handle.abort === "function"
        )
          handle.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle = request({
          method: "POST",
          url: origin + PAGE_CHAT_HTTP_PATH,
          withCredentials: true,
          timeout: 30000,
          headers: {
            "content-type": "application/json",
            "x-lianki-userscript": "1",
            "x-lianki-host-origin": hostOrigin,
            ...(principal ? { [PAGE_CHAT_PRINCIPAL_HEADER]: principal } : {}),
          },
          data: JSON.stringify(input),
          onload: (r) => {
            try {
              const raw = JSON.parse(r.responseText);
              if (
                input.op === "hello" &&
                raw.ok === true &&
                raw.kind === "hello" &&
                typeof raw.principal === "string" &&
                /^[A-Za-z0-9_-]{1,64}$/.test(raw.principal)
              )
                return finish({ ok: true, kind: "hello", principal: raw.principal });
              const result = publicPageChatResult(raw);
              finish(result ?? { ok: false, error: "unavailable" });
            } catch {
              finish({ ok: false, error: "unavailable" });
            }
          },
          onerror: () => finish({ ok: false, error: "unavailable" }),
          ontimeout: () => finish({ ok: false, error: "unavailable" }),
        });
      } catch (error) {
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  };
}
