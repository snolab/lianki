// Fetch a Google Doc's public HTML export (docs shared "anyone with the
// link"). The URL is built from a validated id (lib/gdoc/url.ts); redirects
// are followed by hand and only to Google's own export hosts, so nothing else
// is ever fetched. The export inlines images as base64 `data:` URIs (tens of
// MB for an illustrated doc): they are dropped while streaming, and only the
// remaining markup counts toward the size limit.

import { gdocExportUrl } from "./url";

export type GdocFetchError = "not-shared" | "not-found" | "too-large" | "fetch-failed";

export class GdocError extends Error {
  constructor(public code: GdocFetchError | "no-text" | "too-much-text") {
    super(code);
    this.name = "GdocError";
  }
}

export const GDOC_LIMITS = {
  /** Markup left after images are dropped. */
  maxHtmlChars: 8_000_000,
  /** Everything downloaded, images included. */
  maxRawBytes: 80_000_000,
  maxRedirects: 4,
  timeoutMs: 25_000,
};

/** Where a redirect may lead: the export hosts. A sign-in page means the doc is private. */
function redirectTarget(location: string, base: string): URL | "login" | null {
  let u: URL;
  try {
    u = new URL(location, base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username) return null;
  if (u.hostname === "accounts.google.com") return "login";
  if (u.hostname === "docs.google.com") {
    return /^\/(accounts|ServiceLogin|signin)/i.test(u.pathname) ? "login" : u;
  }
  if (/^[a-z0-9-]+\.googleusercontent\.com$/.test(u.hostname)) return u;
  return null;
}

/** The download name Google sends ("<title>.html"), as the doc's title. */
export function titleFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) name = /filename\s*=\s*"([^"]*)"/i.exec(cd)?.[1] ?? null;
  if (!name) return null;
  const t = name.replace(/\.html?$/i, "").trim();
  return t || null;
}

const DATA_SRC = 'src="data:';

/**
 * Read the body as text with `src="data:…"` values cut out, streaming, so a
 * doc full of images costs its text, not its pictures.
 */
export async function readStripped(
  body: ReadableStream<Uint8Array>,
  limits = GDOC_LIMITS,
): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parts: string[] = [];
  let outLen = 0;
  let raw = 0;
  let inData = false;
  let carry = "";
  const emit = (s: string) => {
    if (!s) return;
    parts.push(s);
    outLen += s.length;
    if (outLen > limits.maxHtmlChars) throw new GdocError("too-large");
  };
  const feed = (chunk: string, last: boolean) => {
    let s = carry + chunk;
    carry = "";
    while (s) {
      if (inData) {
        const q = s.indexOf('"');
        if (q < 0) return;
        inData = false;
        s = s.slice(q);
        continue;
      }
      const i = s.indexOf(DATA_SRC);
      if (i < 0) {
        // Keep a tail that could be the start of a marker split across chunks.
        const keep = last ? 0 : Math.min(s.length, DATA_SRC.length - 1);
        emit(s.slice(0, s.length - keep));
        carry = s.slice(s.length - keep);
        return;
      }
      emit(s.slice(0, i) + 'src="');
      s = s.slice(i + DATA_SRC.length);
      inData = true;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += value.byteLength;
      if (raw > limits.maxRawBytes) throw new GdocError("too-large");
      feed(dec.decode(value, { stream: true }), false);
    }
    feed(dec.decode(), true);
  } finally {
    await reader.cancel().then(undefined, String);
  }
  return parts.join("");
}

/** Discard a response body we will not read (a failed cancel changes nothing). */
async function drop(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

export interface GdocExport {
  html: string;
  title: string | null;
}

export async function fetchGdocHtml(
  id: string,
  fetchImpl: typeof fetch = fetch,
  limits = GDOC_LIMITS,
): Promise<GdocExport> {
  let url = gdocExportUrl(id);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "text/html" },
      });
    } catch {
      throw new GdocError("fetch-failed");
    }
    if (res.status >= 300 && res.status < 400) {
      void drop(res);
      const to = redirectTarget(res.headers.get("location") ?? "", url);
      if (to === "login") throw new GdocError("not-shared");
      if (!to || hop >= limits.maxRedirects) throw new GdocError("fetch-failed");
      url = to.toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      void drop(res);
      throw new GdocError("not-shared");
    }
    if (res.status === 404 || res.status === 410) {
      void drop(res);
      throw new GdocError("not-found");
    }
    if (!res.ok || !res.body) {
      void drop(res);
      throw new GdocError("fetch-failed");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/^text\/html\b/i.test(type)) {
      void drop(res);
      throw new GdocError("fetch-failed");
    }
    const html = await readStripped(res.body, limits);
    // A sign-in page served with 200 (no download name) is a private doc.
    const title = titleFromDisposition(res.headers.get("content-disposition"));
    if (!title && /accounts\.google\.com\/(ServiceLogin|v3\/signin)/.test(html.slice(0, 200_000))) {
      throw new GdocError("not-shared");
    }
    return { html, title };
  }
}
