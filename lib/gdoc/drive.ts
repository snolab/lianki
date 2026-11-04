// A private Google Doc through the user's Google connection (docs/connections.md):
// Drive API v3 `files.get` (name, type) and `files.export` as text/html, with
// the user's `drive.file` access token. `drive.file` reaches only files the
// user opened with Lianki through the Google Picker, so a doc they did not
// pick answers 404 here ("not-granted": the page opens the Picker on it).
//
// No SSRF: the only URLs fetched are www.googleapis.com/drive/v3/files/<id>…,
// built from an id that passed `gdocIdOf`; redirects are refused. The token
// is sent only there and never logged. The body is read as the public export
// is (lib/gdoc/fetch.ts: images dropped while streaming, size-capped).

import { ConnectionError } from "@/lib/connections/google";
import { GOOGLE_DOC_MIME_TYPE as GOOGLE_DOC_MIME } from "@/lib/connections/scopes";
import { GDOC_LIMITS, GdocError, readStripped, type GdocExport } from "./fetch";

const DRIVE = "https://www.googleapis.com/drive/v3/files/";
const ID = /^[A-Za-z0-9_-]{25,128}$/;

export function driveMetaUrl(id: string): string {
  if (!ID.test(id)) throw new GdocError("not-found");
  return `${DRIVE}${id}?fields=name%2CmimeType&supportsAllDrives=true`;
}

export function driveExportUrl(id: string): string {
  if (!ID.test(id)) throw new GdocError("not-found");
  return `${DRIVE}${id}/export?mimeType=text%2Fhtml`;
}

/** Map a Drive error answer to ours. Drive says 404 for a file `drive.file` does not cover. */
async function driveError(res: Response): Promise<Error> {
  let reason = "";
  try {
    const j = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
    reason = j.error?.errors?.[0]?.reason ?? "";
  } catch {
    // not JSON
  }
  if (res.status === 401) return new ConnectionError("reconnect");
  if (reason === "exportSizeLimitExceeded") return new GdocError("too-large");
  if (res.status === 403 && /rateLimit|userRateLimitExceeded|quota/i.test(reason))
    return new GdocError("fetch-failed");
  if (res.status === 403 && reason === "insufficientPermissions")
    return new ConnectionError("no-drive-scope");
  if (res.status === 403 || res.status === 404) return new GdocError("not-granted");
  return new GdocError("fetch-failed");
}

export async function fetchDriveHtml(
  id: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  limits = GDOC_LIMITS,
): Promise<GdocExport> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const get = async (url: string, accept: string) => {
    try {
      return await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new GdocError("fetch-failed");
    }
  };

  const meta = await get(driveMetaUrl(id), "application/json");
  if (!meta.ok) throw await driveError(meta);
  const m = (await meta.json().catch(() => null)) as { name?: unknown; mimeType?: unknown } | null;
  // Only Google Docs documents: a Sheet, a PDF or a Word file is not this import.
  if (m?.mimeType !== GOOGLE_DOC_MIME) throw new GdocError("not-found");
  const title = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 300) : null;

  const res = await get(driveExportUrl(id), "text/html");
  if (!res.ok) throw await driveError(res);
  if (!res.body || !/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) {
    // Discard the body we will not read (a failed cancel changes nothing).
    void res.body?.cancel().then(undefined, String);
    throw new GdocError("fetch-failed");
  }
  return { html: await readStripped(res.body, limits), title };
}
