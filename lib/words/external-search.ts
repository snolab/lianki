/**
 * Exams and word lists Lianki cannot ship for licence reasons
 * (docs/word-deck-sources.md, "Not shipped"), shown in the /words "Add a list"
 * tree with search links only (owner, 2026-11-03 19:45 JST: "我们贴的是搜索链接，
 * 而不是直接指向那个资源的链接"). The data, one query per engine, lives in
 * public/words/external-search.json; this file only builds the URLs. A link
 * opens the engine's own search page in the user's browser: Lianki never
 * fetches it, and never links a specific deck or file.
 */
import data from "../../public/words/external-search.json";

export type SearchEngine = "ankiweb" | "github" | "google";

export type ExternalSearch = {
  /** Unique id: `<lang>-<exam>[-<level>]`. */
  id: string;
  /** BCP 47 base code of the language the exam tests. */
  lang: string;
  /** The exam's name (a product name, the same in every locale). */
  exam: string;
  /** The level, when the exam has several (its row's label under the exam). */
  level?: string;
  /** What to type into each engine's search box. */
  queries: Record<SearchEngine, string>;
};

/** The engines, in the order their links show. */
export const SEARCH_ENGINES: readonly SearchEngine[] = ["ankiweb", "github", "google"];

/** The engines' names on the links (product names, never translated). */
export const ENGINE_NAMES: Record<SearchEngine, string> = {
  ankiweb: "AnkiWeb",
  github: "GitHub",
  google: "Google",
};

const ENDPOINTS: Record<SearchEngine, (q: string) => string> = {
  ankiweb: (q) => `https://ankiweb.net/shared/decks?search=${q}`,
  github: (q) => `https://github.com/search?q=${q}&type=repositories`,
  google: (q) => `https://www.google.com/search?q=${q}`,
};

/** One engine's search page for a query. */
export const searchUrl = (engine: SearchEngine, query: string) =>
  ENDPOINTS[engine](encodeURIComponent(query.trim()));

/** An entry's links, one per engine, in display order. */
export const searchLinks = (s: ExternalSearch) =>
  SEARCH_ENGINES.map((engine) => ({
    engine,
    name: ENGINE_NAMES[engine],
    url: searchUrl(engine, s.queries[engine]),
  }));

export const EXTERNAL_SEARCHES: ExternalSearch[] = data.searches;
