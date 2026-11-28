/** Pure opt-in page context bridge. No startup reads, storage, arbitrary URLs or automatic send. */
import type { ChatGmRequest } from "./page-chat-fetch";
import {
  canonicalExactSiteOrigin,
  parseSitePageReadRequest,
  type SitePageReadRequest,
  type SitePermissionSelection,
} from "../lib/site-permission-wire";
import { publicSitePermissionResult } from "../lib/site-permission-result";
import { uuidv4 } from "../packages/debug-chat/src/uuid";
const apps = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);
export type PageReadResult =
  | { ok: true; selection: SitePermissionSelection }
  | { ok: false; error: "denied" | "empty" | "cancelled" | "unavailable"; settingsUrl: string };
export function sitePageReadBridge(d: {
  appOrigin: string;
  doc: Document;
  request: ChatGmRequest;
}) {
  const site = canonicalExactSiteOrigin(d.doc.location?.origin);
  const settingsUrl = apps.has(d.appOrigin)
    ? d.appOrigin + "/chat/sites" + (site ? "?origin=" + encodeURIComponent(site) : "")
    : "https://lianki.com/chat/sites";
  const failure = (error: "denied" | "empty" | "cancelled" | "unavailable"): PageReadResult => ({
    ok: false,
    error,
    settingsUrl,
  });
  const call = (action: SitePageReadRequest, signal?: AbortSignal, accountBinding?: string) =>
    new Promise<ReturnType<typeof publicSitePermissionResult>>((resolve) => {
      if (!apps.has(d.appOrigin) || !site || !parseSitePageReadRequest(action) || signal?.aborted) {
        resolve(null);
        return;
      }
      let finished = false,
        handle: unknown;
      const finish = (value: ReturnType<typeof publicSitePermissionResult>) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        finish(null);
        if (
          handle &&
          typeof handle === "object" &&
          "abort" in handle &&
          typeof handle.abort === "function"
        )
          handle.abort();
      };
      const timer = setTimeout(() => finish(null), 15000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle = d.request({
          method: "POST",
          url: d.appOrigin + "/api/chat/site-page-read",
          withCredentials: true,
          timeout: 15000,
          headers: {
            "content-type": "application/json",
            "x-lianki-userscript": "1",
            ...(accountBinding ? { "x-lianki-site-account": accountBinding } : {}),
          },
          data: JSON.stringify(action),
          onload: (r) => {
            try {
              finish(
                r.status === 200 ? publicSitePermissionResult(JSON.parse(r.responseText)) : null,
              );
            } catch {
              finish(null);
            }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null),
        });
      } catch {
        finish(null);
      }
    });
  return {
    settingsUrl,
    async readSelection(signal?: AbortSignal): Promise<PageReadResult> {
      if (signal?.aborted) return failure("cancelled");
      if (!site || !apps.has(d.appOrigin)) return failure("unavailable");
      const status = await call({ op: "status", origin: site }, signal);
      if (signal?.aborted) return failure("cancelled");
      if (!status) return failure("unavailable");
      if (
        !status.ok ||
        status.kind !== "grant" ||
        !status.accountBinding ||
        status.grant.origin !== site ||
        !status.grant.enabled
      )
        return failure("denied");
      // Read only after the current exact-site permission is confirmed and the user invoked this callback.
      let text: string;
      try {
        text = d.doc.getSelection()?.toString().slice(0, 9000) ?? "";
      } catch {
        return failure("unavailable");
      }
      if (!text.trim()) return failure("empty");
      const url = new URL(d.doc.location.href);
      url.search = "";
      url.hash = "";
      if (url.origin !== site) return failure("unavailable");
      const read = await call(
        {
          op: "consume",
          origin: site,
          scope: "page.read",
          revision: status.grant.revision,
          requestId: uuidv4().replace(/-/g, "_"),
          selection: { text, title: d.doc.title.slice(0, 300), url: url.href },
        },
        signal,
        status.accountBinding,
      );
      if (signal?.aborted) return failure("cancelled");
      if (!read) return failure("unavailable");
      return read.ok && read.kind === "selection"
        ? { ok: true, selection: read.selection }
        : failure("denied");
    },
  };
}
