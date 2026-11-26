/**
 * Page-realm broker: exactly the feature check and the scoped chat-ticket mint.
 * Never reads GM storage or forwards Authorization, caller headers, bodies or arbitrary URLs.
 */
export type ChatGmRequest = (details: {
  method: string;
  url: string;
  headers: Record<string, string>;
  data?: string;
  withCredentials: true;
  timeout: number;
  onload: (r: { status: number; responseText: string }) => void;
  onerror: () => void;
  ontimeout: () => void;
}) => unknown;
export function pageChatFetch(origin: string, hostOrigin: string, request: ChatGmRequest) {
  return (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; credentials?: string },
  ) => {
    const method = options?.method ?? "GET";
    const state = url === origin + "/api/ext/pill-chat" && method === "GET";
    const ticket = url === origin + "/api/chat/page-ticket" && method === "POST";
    if (!state && !ticket)
      return Promise.reject(new Error("Chat only: open Li on lianki.com for advanced actions"));
    return new Promise<{ ok: boolean; status: number; json: () => Promise<any> }>(
      (resolve, reject) => {
        request({
          method,
          url,
          withCredentials: true,
          timeout: 8000,
          headers: ticket ? { "x-lianki-userscript": "1", "x-lianki-host-origin": hostOrigin } : {},
          onload: (r) =>
            resolve({
              ok: r.status >= 200 && r.status < 300,
              status: r.status,
              json: async () => JSON.parse(r.responseText),
            }),
          onerror: () => reject(new Error("Li chat connection failed")),
          ontimeout: () => reject(new Error("Li chat connection timed out")),
        });
      },
    );
  };
}
