// The one path from a link (pasted, or a search hit) to an importable
// catalogue entry: parse → a curated or shared entry for the same work, else
// the host's facts (cached) → the admission rule for this viewer. Used by
// /api/books/resolve (show the verdict) and /api/books/import { url } (import
// it; a confirmed work becomes a shared catalogue entry for everyone).

import { CATALOGUE, type CatalogueBook } from "./catalogue";
import {
  entryForLink,
  fetchMeta,
  judge,
  judgeEntry,
  linkKey,
  parseBookLink,
  readFacts,
  WIKISOURCE_SITES,
  type Verdict,
  type WorkFacts,
} from "./resolve";
import {
  AOZORA_INDEX_URL,
  aozoraIndex,
  cleanQuery,
  fetchZip,
  searchAozoraIndex,
  searchGutenberg,
  searchStandardEbooks,
  searchWikisource,
  SEARCH_LIMITS,
  unzipOne,
  type AozoraRow,
  type SearchHit,
} from "./search";

import type { SharedStore } from "./shared";
import { BookSourceFail, loadSource, parseSource, type SourceCache } from "./source";
import { checkBook } from "@/lib/read/book";

export interface LookupDeps {
  shared: SharedStore;
  /** R2 in production (the same bucket as the source files); null skips caching. */
  cache: SourceCache | null;
  fetchImpl?: typeof fetch;
  now?: number;
}

const DAY = 86_400_000;
/** How long read facts and search answers are reused. */
export const META_TTL = { facts: 7 * DAY, search: DAY, aozoraIndex: 7 * DAY };

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A JSON value from the cache while fresh, else made and stored. A failing cache is skipped. */
async function cached<T>(
  deps: LookupDeps,
  key: string,
  ttl: number,
  make: () => Promise<T>,
): Promise<T> {
  const now = deps.now ?? Date.now();
  if (deps.cache) {
    try {
      const hit = await deps.cache.get(key);
      if (hit) {
        const v = JSON.parse(hit) as { at: number; value: T };
        if (now - v.at < ttl) return v.value;
      }
    } catch (err) {
      console.error("books: meta cache read failed", err);
    }
  }
  const value = await make();
  if (deps.cache) {
    try {
      await deps.cache.put(key, JSON.stringify({ at: now, value }));
    } catch (err) {
      console.error("books: meta cache write failed", err);
    }
  }
  return value;
}

export interface Resolved {
  verdict: Verdict;
  /** The resolver's key for the work, when the link was one we read. */
  link?: string;
}

/** A link → its verdict for a viewer (null country = unknown → the conservative default). */
export async function resolveLink(
  raw: unknown,
  viewer: string | null,
  year: number,
  deps: LookupDeps,
): Promise<Resolved> {
  const link = typeof raw === "string" && raw.length <= 2000 ? parseBookLink(raw) : null;
  if (!link) return { verdict: { ok: false, reason: "bad-link" } };
  const key = linkKey(link);
  const curated = entryForLink(link, CATALOGUE);
  if (curated) return { verdict: judgeEntry(curated, viewer, year), link: key };
  const shared = await deps.shared.byLink(key);
  if (shared) return { verdict: judgeEntry(shared, viewer, year), link: key };
  const get = (url: string) => fetchMeta(url, deps.fetchImpl);
  const facts = await cached<WorkFacts | null>(
    deps,
    `preset-cache/meta/${await sha(key)}.json`,
    META_TTL.facts,
    () =>
      readFacts(link, get).catch((err) => {
        // A page the host does not have is "not found"; anything else is retried next time.
        if ((err as { code?: string }).code === "no-text") return null;
        throw err;
      }),
  );
  if (!facts) return { verdict: { ok: false, reason: "not-found" }, link: key };
  const taken = new Set(CATALOGUE.filter((b) => b.lang === facts.lang).map((b) => b.slug));
  const verdict = judge(facts, viewer, year, taken);
  return { verdict: verdict.ok ? { ...verdict, curated: false } : verdict, link: key };
}

/**
 * A confirmed verdict's entry, made shared when it is not curated (one entry
 * per work). A new work is listed only after its file was fetched and parsed
 * into a book: a source the importer cannot read never reaches the list.
 */
export async function entryToImport(r: Resolved, deps: LookupDeps): Promise<CatalogueBook | null> {
  if (!r.verdict.ok) return null;
  if (r.verdict.curated || !r.link) return r.verdict.book;
  const { html } = await loadSource(r.verdict.book, deps.cache, deps.fetchImpl);
  const checked = checkBook(parseSource(r.verdict.book, html));
  if (!checked.ok)
    throw new BookSourceFail(checked.error === "too-much-text" ? "too-large" : "no-text");
  return deps.shared.add(r.link, r.verdict.book);
}

/** Search every library we read; a source that fails is left out of the answer. */
export async function searchLibraries(raw: unknown, deps: LookupDeps): Promise<SearchHit[]> {
  const q = cleanQuery(raw);
  if (!q) return [];
  const get = (url: string) => fetchMeta(url, deps.fetchImpl);
  return cached(
    deps,
    `preset-cache/search/${await sha(q.toLowerCase())}.json`,
    META_TTL.search,
    async () => {
      const sources: Promise<SearchHit[]>[] = [
        searchGutenberg(q, get),
        searchStandardEbooks(q, get),
        aozoraRows(deps).then((rows) => searchAozoraIndex(rows, q)),
        // Wikisource last: its full-text search also finds dictionaries and documents.
        ...Object.keys(WIKISOURCE_SITES).map((site) => searchWikisource(site, q, get)),
      ];
      const settled = await Promise.allSettled(sources);
      // Every library failing is an outage, not "nothing found": not cached.
      if (settled.every((s) => s.status === "rejected"))
        throw new Error("books: every library failed");
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      for (const s of settled) {
        if (s.status !== "fulfilled") {
          console.error("books: a library search failed", s.reason);
          continue;
        }
        for (const h of s.value) {
          const l = parseBookLink(h.url);
          if (!l || seen.has(linkKey(l))) continue;
          seen.add(linkKey(l));
          hits.push(h);
        }
      }
      return hits.slice(0, SEARCH_LIMITS.total);
    },
  );
}

/** Aozora's index of works, from the cache or its zip. */
function aozoraRows(deps: LookupDeps): Promise<AozoraRow[]> {
  return cached(deps, "preset-cache/meta/aozora-index.json", META_TTL.aozoraIndex, async () => {
    const zip = await fetchZip(AOZORA_INDEX_URL, deps.fetchImpl);
    const csv = new TextDecoder("utf-8").decode(await unzipOne(zip));
    return aozoraIndex(csv);
  });
}
