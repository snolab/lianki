// "到公版图书馆搜索": the server asks the libraries themselves — Gutendex
// (Project Gutenberg's catalogue), Standard Ebooks' catalogue search, each
// Wikisource site we read (lib/books/libraries.ts), and Aozora Bunko's own
// index of works — and answers links. Each result then goes
// through the one resolve path (lib/books/resolve.ts) before it can be
// imported: the search itself decides nothing about copyright.
//
// Results are cached (R2, a day) per query; the Aozora index (one CSV in a zip,
// ~2 MB) is cached as a compact list for a week.

import { WIKISOURCE_SITES, fetchMeta, linkPage, parseBookLink, type BookLink } from "./resolve";
import { BookSourceFail } from "./source";

export interface SearchHit {
  /** The book's page: what resolve and import take. */
  url: string;
  title: string;
  author: string;
  lang: string | null;
  /** The library, as shown. */
  site: string;
}

/**
 * Hits per library, per Wikisource site (there are many, and their full-text
 * search also finds documents), and in all: each hit is then checked by the
 * page, so the answer stays short.
 */
export const SEARCH_LIMITS = { perSource: 8, perWikisource: 3, total: 40, maxQuery: 80 };

/** A query we send on: trimmed, single-spaced, capped; "" when too short to mean anything. */
export function cleanQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const q = raw.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, SEARCH_LIMITS.maxQuery);
  return [...q].length >= 2 ? q : "";
}

type Get = (url: string) => Promise<string>;

/** Project Gutenberg's catalogue through Gutendex: books with their authors. */
export async function searchGutenberg(q: string, get: Get): Promise<SearchHit[]> {
  const j = JSON.parse(
    await get(`https://gutendex.com/books/?search=${encodeURIComponent(q)}`),
  ) as {
    results?: {
      id: number;
      title: string;
      authors?: { name: string }[];
      languages?: string[];
      copyright?: boolean | null;
    }[];
  };
  return (j.results ?? [])
    .filter((b) => b.copyright === false && Number.isInteger(b.id))
    .slice(0, SEARCH_LIMITS.perSource)
    .map((b) => ({
      url: `https://www.gutenberg.org/ebooks/${b.id}`,
      title: b.title,
      author: (b.authors ?? []).map((a) => a.name.replace(/^([^,]+),\s*(.+)$/, "$2 $1")).join(", "),
      lang: b.languages?.length === 1 ? b.languages[0] : null,
      site: "Project Gutenberg",
    }));
}

/** One Wikisource site's own search (main namespace). */
export async function searchWikisource(site: string, q: string, get: Get): Promise<SearchHit[]> {
  const j = JSON.parse(
    await get(
      `https://${site}/w/api.php?action=query&format=json&formatversion=2&list=search&srnamespace=0&srlimit=${SEARCH_LIMITS.perWikisource}&srsearch=${encodeURIComponent(q)}`,
    ),
  ) as { query?: { search?: { title: string }[] } };
  // A sub-page (a dictionary entry, one chapter) is not a book.
  return (j.query?.search ?? [])
    .filter((r) => !r.title.includes("/"))
    .map((r) => {
      const link: BookLink = { host: "wikisource", site, title: r.title };
      return {
        url: linkPage(link),
        title: r.title,
        author: "",
        lang: WIKISOURCE_SITES[site],
        site: "Wikisource",
      };
    });
}

/**
 * Standard Ebooks' own catalogue search (its HTML results page): produced
 * ebooks only, a placeholder (a book not made yet) is left out.
 */
export async function searchStandardEbooks(q: string, get: Get): Promise<SearchHit[]> {
  const html = await get(`https://standardebooks.org/ebooks?query=${encodeURIComponent(q)}`);
  const out: SearchHit[] = [];
  for (const m of html.matchAll(
    /<li\b[^>]*typeof="schema:Book"[^>]*about="(\/ebooks\/[^"]+)"[^>]*>([\s\S]*?)<\/li>/g,
  )) {
    if (/placeholder-cover/.test(m[2])) continue;
    const link = parseBookLink(`https://standardebooks.org${m[1]}`);
    if (!link) continue;
    const name = (re: RegExp) =>
      (re.exec(m[2])?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
    const title = name(/<p><a\b[^>]*><span property="schema:name">([\s\S]*?)<\/span>/);
    if (!title) continue;
    const authors = [
      ...m[2].matchAll(/<p class="author"[\s\S]*?<span property="schema:name">([\s\S]*?)<\/span>/g),
    ].map((a) => a[1].replace(/<[^>]+>/g, "").trim());
    out.push({
      url: linkPage(link),
      title,
      author: authors.join(", "),
      lang: "en",
      site: "Standard Ebooks",
    });
    if (out.length >= SEARCH_LIMITS.perSource) break;
  }
  return out;
}

/** One work in Aozora's index: card page, title, the people and whether Aozora marks it in copyright. */
export type AozoraRow = [card: string, title: string, people: string, inCopyright: 0 | 1];

/** Fields of a CSV line (RFC 4180: quotes, doubled quotes, commas inside quotes). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Aozora's list_person_all_extended CSV → one row per work (its people joined). */
export function aozoraIndex(csv: string): AozoraRow[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  const head = csvFields(lines[0] ?? "");
  const col = (name: string) => head.indexOf(name);
  const [cTitle, cCard, cLast, cFirst, cRole, cWorkCopy] = [
    col("作品名"),
    col("図書カードURL"),
    col("姓"),
    col("名"),
    col("役割フラグ"),
    col("作品著作権フラグ"),
  ];
  if ([cTitle, cCard, cLast, cWorkCopy].some((c) => c < 0)) return [];
  const works = new Map<string, AozoraRow>();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = csvFields(line);
    const card = f[cCard];
    if (!card || !parseBookLink(card)) continue;
    const person = `${f[cLast] ?? ""}${f[cFirst] ?? ""}${cRole >= 0 && f[cRole] && f[cRole] !== "著者" ? `（${f[cRole]}）` : ""}`;
    const prev = works.get(card);
    if (prev) prev[2] = `${prev[2]}、${person}`;
    else works.set(card, [card, f[cTitle] ?? "", person, f[cWorkCopy] === "あり" ? 1 : 0]);
  }
  return [...works.values()];
}

/** Read a one-file zip (Aozora's index) with the platform's own inflate; size-capped. */
export async function unzipOne(zip: Uint8Array, maxBytes = 40_000_000): Promise<Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (zip.byteLength < 30 || dv.getUint32(0, true) !== 0x04034b50)
    throw new BookSourceFail("no-text");
  const method = dv.getUint16(8, true);
  let size = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  if (size === 0 || size > zip.byteLength - start) {
    // Sizes in the data descriptor (bit 3): take the rest up to the central directory.
    const cd = (() => {
      for (let i = zip.byteLength - 22; i >= 0; i--)
        if (dv.getUint32(i, true) === 0x06054b50) return dv.getUint32(i + 16, true);
      return zip.byteLength;
    })();
    size = cd - start;
  }
  const data = zip.subarray(start, start + size);
  if (method === 0) return data;
  if (method !== 8) throw new BookSourceFail("no-text");
  const stream = new Blob([new Uint8Array(data)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel();
      throw new BookSourceFail("too-large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export const AOZORA_INDEX_URL =
  "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";

/** Works in Aozora's index whose title or people contain the query; works Aozora marks in copyright are left out. */
export function searchAozoraIndex(rows: AozoraRow[], q: string): SearchHit[] {
  const needle = q.toLowerCase();
  const out: SearchHit[] = [];
  for (const [card, title, people, inCopyright] of rows) {
    if (inCopyright) continue;
    if (!title.toLowerCase().includes(needle) && !people.toLowerCase().includes(needle)) continue;
    out.push({
      url: card.replace(/^http:/, "https:"),
      title,
      author: people,
      lang: "ja",
      site: "青空文庫 Aozora Bunko",
    });
    if (out.length >= SEARCH_LIMITS.perSource) break;
  }
  return out;
}

/** Fetch a zip from an allowed host as bytes (the metadata fetch is text-only). */
export async function fetchZip(
  url: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes = 6_000_000,
): Promise<Uint8Array> {
  if (!/^https:\/\/www\.aozora\.gr\.jp\/index_pages\/[\w.-]+\.zip$/.test(url))
    throw new BookSourceFail("fetch-failed");
  let res: Response;
  try {
    res = await fetchImpl(url, {
      // Workers have no "error" mode: a redirect (any 3xx) is refused below as not ok.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "Lianki (lianki.com) library search" },
    });
  } catch {
    throw new BookSourceFail("fetch-failed");
  }
  if (!res.ok) throw new BookSourceFail("fetch-failed");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes)
    throw new BookSourceFail("too-large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new BookSourceFail("too-large");
  return buf;
}

export { fetchMeta };
