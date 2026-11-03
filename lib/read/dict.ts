// The words our public word lists (public/words/*.json) hold for a language,
// as lookup keys (lib/read/words.ts termKeys): a book word without a card is
// "new" when one of these has it, "unrecognised" when none does. Read from
// the catalogs the device already caches for /words (lib/words/catalog-cache).
import { loadCatalog } from "@/lib/words/catalog-cache";
import { langMatches, termKeys } from "./words";

type Index = { lists: { id: string; lang: string; file: string }[] };
type Catalog = { entries: { term: string; reading?: string | null }[] };

const cache = new Map<string, Promise<Set<string>>>();

export function catalogKeys(lang: string): Promise<Set<string>> {
  if (lang === "und") return Promise.resolve(new Set());
  let p = cache.get(lang);
  if (!p) {
    p = (async () => {
      const index = await loadCatalog<Index>("/words/index.json");
      const files = index.lists.filter((l) => langMatches(l.lang, lang)).map((l) => l.file);
      const keys = new Set<string>();
      const cats = await Promise.all(
        files.map((f) => loadCatalog<Catalog>(`/words/${f}`).catch(() => null)),
      );
      for (const c of cats)
        for (const e of c?.entries ?? [])
          for (const k of termKeys(e.term, e.reading, lang)) keys.add(k);
      return keys;
    })();
    p.catch(() => cache.delete(lang));
    cache.set(lang, p);
  }
  return p;
}

/** A catalog word, as the in-place word review shows it (its meaning). */
export interface CatalogWord {
  term: string;
  reading?: string | null;
  back: string;
}
type FullCatalog = { entries: CatalogWord[] };
const words = new Map<string, Promise<Map<string, CatalogWord>>>();

/**
 * The catalogs' words by lookup key, first catalog first: the meaning a word
 * of the book is shown with in the in-place review. Loaded only when that
 * sheet opens (the same cached files as catalogKeys).
 */
export function catalogWords(lang: string): Promise<Map<string, CatalogWord>> {
  if (lang === "und") return Promise.resolve(new Map());
  let p = words.get(lang);
  if (!p) {
    p = (async () => {
      const index = await loadCatalog<Index>("/words/index.json");
      const files = index.lists.filter((l) => langMatches(l.lang, lang)).map((l) => l.file);
      const out = new Map<string, CatalogWord>();
      const cats = await Promise.all(
        files.map((f) => loadCatalog<FullCatalog>(`/words/${f}`).catch(() => null)),
      );
      for (const c of cats)
        for (const e of c?.entries ?? [])
          if (e.back)
            for (const k of termKeys(e.term, e.reading, lang)) if (!out.has(k)) out.set(k, e);
      return out;
    })();
    p.catch(() => words.delete(lang));
    words.set(lang, p);
  }
  return p;
}
