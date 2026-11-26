/** Synthetic browser fixture only: the manager API is supplied by the local QA process. */
import { startPortableLi } from "../../src/portable-li";
import { pageChatHttpClient } from "../../src/page-chat-http-client";
import { PILLCHAT_ON_KEY } from "../../src/pill-chat-trust";
import type { ChatGmRequest } from "../../src/page-chat-fetch";
declare const __portableQaSeed: Record<string, unknown>;
declare function __portableQaStore(key: string, value: unknown): Promise<void>;
declare function __portableQaCall(
  id: string,
  details: unknown,
): Promise<{ status: number; responseText: string }>;
declare function __portableQaAbort(id: string): Promise<void>;
const values = new Map(Object.entries(__portableQaSeed));
values.set(PILLCHAT_ON_KEY, JSON.stringify({ on: true, at: Date.now() }));
const watchers = new Map<string, Set<() => void>>();
const gm = {
  getValue: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
  setValue: (key: string, value: unknown) => {
    values.set(key, value);
    void __portableQaStore(key, value);
    for (const changed of watchers.get(key) ?? []) changed();
  },
};
const roots: ShadowRoot[] = [];
// The product uses closed shadow roots. This fixture records them for geometry assertions only.
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (options) {
  const root = attach.call(this, options);
  roots.push(root);
  return root;
};
const request: ChatGmRequest = (details) => {
  const id = crypto.randomUUID();
  let aborted = false;
  void __portableQaCall(id, {
    method: details.method,
    url: details.url,
    headers: details.headers,
    data: details.data,
  }).then(
    (result) => {
      if (!aborted) details.onload(result);
    },
    () => {
      if (!aborted) details.onerror();
    },
  );
  return {
    abort() {
      aborted = true;
      void __portableQaAbort(id);
    },
  };
};
const controller = startPortableLi({
  gm,
  doc: document,
  win: window,
  origin: "https://lianki.com",
  hostOrigin: location.origin,
  top: true,
  call: pageChatHttpClient("https://lianki.com", location.origin, request),
  watch: (key, changed) => {
    const set = watchers.get(key) ?? new Set();
    set.add(changed);
    watchers.set(key, set);
    return () => {
      set.delete(changed);
    };
  },
});
Object.assign(globalThis, {
  __portableQa: {
    read: () => Object.fromEntries(values),
    remote(key: string, value: unknown) {
      values.set(key, value);
      for (const changed of watchers.get(key) ?? []) changed();
    },
    rect(text: string) {
      for (const root of roots)
        for (const b of root.querySelectorAll("button"))
          if (b.textContent === text && b.isConnected && b.getClientRects().length) {
            const r = b.getBoundingClientRect();
            return {
              x: r.x + r.width / 2,
              y: r.y + r.height / 2,
              width: r.width,
              height: r.height,
            };
          }
      return null;
    },
    input() {
      for (const root of roots) {
        const input = root.querySelector("textarea");
        if (input?.isConnected && input.getClientRects().length) {
          const r = input.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    },
    state() {
      return {
        text: roots
          .filter((r) => r.host.isConnected)
          .map((r) => r.textContent)
          .join("\n"),
        hosts: document.querySelectorAll("lianki-portable-chat").length,
        consents: document.querySelectorAll("lianki-portable-consent").length,
        focused: (document.activeElement as HTMLElement)?.id,
        iframes: document.querySelectorAll("iframe").length,
        panel: roots
          .filter((r) => r.host.isConnected)
          .map((r) => ({
            width: r.host.getBoundingClientRect().width,
            section: r.querySelector("section")?.getBoundingClientRect().toJSON(),
            position: getComputedStyle(r.host).position,
          })),
      };
    },
    destroy: () => controller.destroy(),
  },
});
