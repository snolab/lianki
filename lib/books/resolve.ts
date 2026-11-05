// A book link from an allowed host → the work's facts → the admission rule
// (docs/books-plan.md, "Paste a link, or search the libraries").
//
// One path for the paste-link box and the library search: the link is reduced
// to a host and an id (never fetched as given), the host's own metadata is read
// (Project Gutenberg's ebook page, Aozora Bunko's card, Wikisource's Wikidata
// item), and the facts the rule needs — every creator with a death year and a
// role, the first-publication year and country — must all be stated there.
// A missing or uncertain fact refuses the book with that reason; nothing is
// guessed. A link to a curated entry resolves to that entry.
//
// Hosts and their formats are data; one reader per host, never per language.

import { BOOK_LIMITS } from "@/lib/read/book";
import { CATALOGUE, SOURCE_HOSTS, type CatalogueBook } from "./catalogue";
import { BookSourceFail, decodeSource } from "./source";
import { newSlug } from "./slug";
import { pdIn, normaliseCountry, type Creator, type CreatorRole } from "./terms";

/** Where a link points: the host and the work's id there. */
export type BookLink =
  | { host: "gutenberg"; id: number }
  | { host: "aozora"; person: string; card: number }
  | { host: "wikisource"; site: string; title: string };

/** Wikisource sites we read: their language is the text's (data, one per site). */
export const WIKISOURCE_SITES: Readonly<Record<string, string>> = {
  "zh.wikisource.org": "zh",
  "ru.wikisource.org": "ru",
};

/** Hosts the metadata readers may fetch (besides the source hosts). */
export const META_HOSTS = [...SOURCE_HOSTS, "www.wikidata.org", "gutendex.com"] as const;

/** A link the user pasted → its host and id, or null when it is not a book link we read. */
export function parseBookLink(raw: string): BookLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === "www.gutenberg.org" || host === "gutenberg.org") {
    const m = /^\/(?:ebooks|cache\/epub|files)\/(\d{1,7})(?:[/.]|$)/.exec(path);
    return m ? { host: "gutenberg", id: Number(m[1]) } : null;
  }
  if (host === "www.aozora.gr.jp" || host === "aozora.gr.jp") {
    const card = /^\/cards\/(\d{6})\/card(\d{1,7})\.html$/.exec(path);
    if (card) return { host: "aozora", person: card[1], card: Number(card[2]) };
    const file = /^\/cards\/(\d{6})\/files\/(\d{1,7})_\d+\.html$/.exec(path);
    return file ? { host: "aozora", person: file[1], card: Number(file[2]) } : null;
  }
  const site = host.replace(/^([a-z]+)\.m\.wikisource\.org$/, "$1.wikisource.org");
  if (WIKISOURCE_SITES[site]) {
    const m = /^\/wiki\/(.+)$/.exec(path);
    if (!m) return null;
    let title: string;
    try {
      title = decodeURIComponent(m[1]).replace(/_/g, " ").normalize("NFC").trim();
    } catch {
      return null;
    }
    if (!title || title.length > 250 || /[#<>[\]{}|]/.test(title)) return null;
    // Only the main namespace: a book, not a talk, author or index page.
    if (/^[^:]{1,30}:/.test(title)) return null;
    return { host: "wikisource", site, title };
  }
  return null;
}

/** The link's canonical form: one key per work, for the cache and for matching. */
export function linkKey(l: BookLink): string {
  if (l.host === "gutenberg") return `gutenberg:${l.id}`;
  if (l.host === "aozora") return `aozora:${l.person}/${l.card}`;
  return `wikisource:${l.site}/${l.title}`;
}

/** The human page of a link (what the card links to). */
export function linkPage(l: BookLink): string {
  if (l.host === "gutenberg") return `https://www.gutenberg.org/ebooks/${l.id}`;
  if (l.host === "aozora") return `https://www.aozora.gr.jp/cards/${l.person}/card${l.card}.html`;
  return `https://${l.site}/wiki/${encodeURI(l.title.replace(/ /g, "_"))}`;
}

/** The curated or shared entry for this link's work, if there is one. */
export function entryForLink(l: BookLink, list: CatalogueBook[] = CATALOGUE): CatalogueBook | null {
  const key = linkKey(l);
  return (
    list.find((b) => {
      const own = parseBookLink(b.source.page);
      return own ? linkKey(own) === key : false;
    }) ?? null
  );
}

// ── Facts ───────────────────────────────────────────────────────────────────

/** A creator as the source states them; a death year the source does not give is null. */
export interface StatedCreator {
  name: string;
  role: CreatorRole;
  deathYear: number | null;
}

/** What the host's metadata says about a work. Null = not stated. */
export interface WorkFacts {
  link: BookLink;
  title: string;
  author: string;
  lang: string | null;
  creators: StatedCreator[];
  firstPublicationYear: number | null;
  workCountry: string | null;
  /** The source's own statement that the work is public domain in the US, where it makes one. */
  usPublicDomain?: boolean;
  /** A translation: not an original-language text. */
  translation: boolean;
  /** A role we cannot place (stated, but none of author/translator/editor/illustrator). */
  unknownRole?: string;
  source: CatalogueBook["source"];
  licence: string;
  attribution: string;
}

/** Why a link cannot be imported. Shown with its reason; never a guess. */
export type RefuseReason =
  | "bad-link"
  | "not-found"
  | "missing-death-year"
  | "missing-first-publication"
  | "missing-country"
  | "missing-language"
  | "translation"
  | "unknown-role"
  | "not-public-domain-us"
  | "not-public-domain-origin"
  | "not-public-domain-here";

export type Verdict =
  | { ok: true; book: CatalogueBook; curated: boolean }
  | { ok: false; reason: RefuseReason; facts?: WorkFacts; detail?: string };

/**
 * The admission rule on stated facts: every fact present, an original text,
 * public domain in the US, its own country and the viewer's (null = unknown →
 * the conservative default). The book is a catalogue entry (no level hint).
 */
export function judge(
  facts: WorkFacts,
  viewerCountry: string | null,
  year: number,
  taken: Set<string> = new Set(),
): Verdict {
  const refuse = (reason: RefuseReason, detail?: string): Verdict => ({
    ok: false,
    reason,
    facts,
    ...(detail ? { detail } : {}),
  });
  if (facts.translation) return refuse("translation");
  if (facts.unknownRole) return refuse("unknown-role", facts.unknownRole);
  if (!facts.creators.length) return refuse("missing-death-year");
  const missing = facts.creators.find((c) => c.deathYear === null);
  if (missing) return refuse("missing-death-year", missing.name);
  if (facts.firstPublicationYear === null) return refuse("missing-first-publication");
  const country = facts.workCountry ? normaliseCountry(facts.workCountry) : null;
  if (!country) return refuse("missing-country");
  if (!facts.lang) return refuse("missing-language");
  if (facts.usPublicDomain === false) return refuse("not-public-domain-us");
  const creators: Creator[] = facts.creators.map((c) => ({
    name: c.name,
    role: c.role,
    deathYear: c.deathYear!,
  }));
  const work = { workCountry: country, firstPublicationYear: facts.firstPublicationYear, creators };
  if (!pdIn(work, "US", year)) return refuse("not-public-domain-us");
  if (!pdIn(work, country, year)) return refuse("not-public-domain-origin", country);
  if (!pdIn(work, viewerCountry, year))
    return refuse("not-public-domain-here", viewerCountry ?? "");
  const slug = newSlug(facts.title, taken, [facts.author, String(facts.firstPublicationYear)]);
  if (!slug) return refuse("bad-link");
  return {
    ok: true,
    curated: false,
    book: {
      slug,
      title: facts.title.slice(0, BOOK_LIMITS.maxTitleChars),
      author: facts.author,
      lang: facts.lang,
      level: "",
      workCountry: country,
      firstPublicationYear: facts.firstPublicationYear,
      creators,
      source: facts.source,
      licence: facts.licence,
      attribution: facts.attribution,
    },
  };
}

// ── Fetching metadata ───────────────────────────────────────────────────────

export const META_LIMITS = { maxBytes: 3_000_000, timeoutMs: 15_000, maxRedirects: 3 };

/** A metadata URL the server may fetch: https on a metadata host, default port, no credentials. */
export function allowedMetaUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  return (META_HOSTS as readonly string[]).includes(u.hostname) ? u : null;
}

/** Fetch a metadata page or JSON from an allowed host: redirects by hand within them, size-capped. */
export async function fetchMeta(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  limits = META_LIMITS,
): Promise<string> {
  let url = allowedMetaUrl(raw);
  if (!url) throw new BookSourceFail("fetch-failed");
  const signal = AbortSignal.timeout(limits.timeoutMs);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal,
        headers: { "User-Agent": "Lianki (lianki.com) public-domain check" },
      });
    } catch {
      throw new BookSourceFail("fetch-failed");
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(String);
      const next = allowedMetaUrl(new URL(res.headers.get("location") ?? "", url).toString());
      if (!next || hop >= limits.maxRedirects) throw new BookSourceFail("fetch-failed");
      url = next;
      continue;
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(String);
      throw new BookSourceFail("no-text");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(String);
      throw new BookSourceFail("fetch-failed");
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > limits.maxBytes) {
      await res.body.cancel().catch(String);
      throw new BookSourceFail("too-large");
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > limits.maxBytes) throw new BookSourceFail("too-large");
    return decodeSource(buf, res.headers.get("content-type") ?? "");
  }
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Potter, Beatrix" → "Beatrix Potter"; "Baum, L. Frank (Lyman Frank)" → "L. Frank Baum". */
export function displayName(inverted: string): string {
  const plain = inverted.replace(/\s*\([^)]*\)/g, "").trim();
  const parts = plain.split(/,\s*/);
  if (parts.length < 2) return plain;
  const [last, first, ...rest] = parts;
  // "Tolstoy, Leo, graf": a title after the given name stays out.
  void rest;
  return `${first} ${last}`.trim();
}

/** Language names (in English) → their ISO 639-1 code, built from Intl, for every two-letter code. */
let LANGS: Map<string, string> | null = null;
export function languageCode(name: string): string | null {
  if (!LANGS) {
    LANGS = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const a = "a".charCodeAt(0);
    for (let i = 0; i < 26; i++)
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(a + i, a + j);
        let n: string | undefined;
        try {
          n = names.of(code);
        } catch {
          n = undefined;
        }
        if (n && n !== code && !LANGS.has(n.toLowerCase())) LANGS.set(n.toLowerCase(), code);
      }
  }
  return LANGS.get(name.trim().toLowerCase()) ?? null;
}

/** Publication places as data: a city as sources print it → its country. Ambiguous names are not here. */
export const PLACES: Readonly<Record<string, string>> = {
  london: "GB",
  edinburgh: "GB",
  glasgow: "GB",
  oxford: "GB",
  manchester: "GB",
  liverpool: "GB",
  birmingham: "GB",
  dublin: "IE",
  "new york": "US",
  boston: "US",
  philadelphia: "US",
  chicago: "US",
  indianapolis: "US",
  "san francisco": "US",
  baltimore: "US",
  "cambridge, mass": "US",
  "cambridge, ma": "US",
  "garden city": "US",
  paris: "FR",
  lyon: "FR",
  tours: "FR",
  bruxelles: "BE",
  brussels: "BE",
  genève: "CH",
  geneva: "CH",
  lausanne: "CH",
  zürich: "CH",
  zurich: "CH",
  berlin: "DE",
  leipzig: "DE",
  münchen: "DE",
  munich: "DE",
  stuttgart: "DE",
  "frankfurt am main": "DE",
  "frankfurt a. m": "DE",
  hamburg: "DE",
  dresden: "DE",
  wien: "AT",
  vienna: "AT",
  madrid: "ES",
  barcelona: "ES",
  lisboa: "PT",
  lisbon: "PT",
  porto: "PT",
  "rio de janeiro": "BR",
  "são paulo": "BR",
  milano: "IT",
  milan: "IT",
  firenze: "IT",
  florence: "IT",
  roma: "IT",
  rome: "IT",
  torino: "IT",
  turin: "IT",
  napoli: "IT",
  bologna: "IT",
  venezia: "IT",
  amsterdam: "NL",
  leiden: "NL",
  "'s-gravenhage": "NL",
  stockholm: "SE",
  københavn: "DK",
  kjøbenhavn: "DK",
  copenhagen: "DK",
  kristiania: "NO",
  christiania: "NO",
  oslo: "NO",
  helsinki: "FI",
  helsingfors: "FI",
  "st. petersburg": "RU",
  "санкт-петербург": "RU",
  "с.-петербург": "RU",
  moscow: "RU",
  москва: "RU",
  toronto: "CA",
  montreal: "CA",
  sydney: "AU",
  melbourne: "AU",
  tokyo: "JP",
  東京: "JP",
  praha: "CZ",
  prague: "CZ",
  budapest: "HU",
  warszawa: "PL",
  kraków: "PL",
};

/** "London: Frederick Warne and Co., 1902." → { year: 1902, country: "GB" }; either may be null. */
export function originalPublication(raw: string): { year: number | null; country: string | null } {
  const years = [...raw.matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g)].map((m) => Number(m[1]));
  // Several years ("1902; reprinted 1915") — the latest, which is stricter for the US rule.
  const year = years.length ? Math.max(...years) : null;
  const place = raw.split(":")[0].trim().toLowerCase().replace(/\.$/, "");
  const country =
    PLACES[place] ??
    // "Leipzig [etc.]", "New York and London": the first place, when the rest names the same country.
    (() => {
      const first = place.split(/\s*(?:,|\band\b|&|;|\[)\s*/)[0];
      return PLACES[first] ?? null;
    })();
  return { year, country };
}

const ROLE_OF: Readonly<Record<string, CreatorRole>> = {
  author: "author",
  creator: "author",
  illustrator: "illustrator",
  photographer: "illustrator",
  editor: "editor",
  compiler: "editor",
  annotator: "editor",
  commentator: "editor",
  contributor: "editor",
  "author of introduction, etc.": "editor",
  "author of afterword, colophon, etc.": "editor",
  "writer of introduction": "editor",
  "writer of preface": "editor",
  translator: "translator",
};

/** "Potter, Beatrix, 1866-1943" → the name and the death year the line states (BCE negative). */
export function gutenbergPerson(raw: string): { name: string; deathYear: number | null } {
  const m =
    /,\s*(?:(\d{1,4})\s*(BCE)?)?\s*-\s*(\d{1,4})\s*(BCE)?\s*$/.exec(raw) ??
    /,\s*(?:approximately|active|flourished|ca\.)[^,]*$/.exec(raw);
  if (!m || m[3] === undefined) {
    const name = raw.replace(/,\s*[^,]*\d[^,]*$/, "");
    return { name: displayName(name), deathYear: null };
  }
  const name = raw.slice(0, m.index);
  const death = Number(m[3]) * (m[4] ? -1 : 1);
  return { name: displayName(name), deathYear: death };
}

/** Project Gutenberg's ebook page → the facts its bibliographic record states. */
export function gutenbergFacts(id: number, html: string): WorkFacts | null {
  const table = /<table[^>]*class="bibrec"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (!table) return null;
  const rows = [
    ...table.matchAll(/<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g),
  ].map((m) => [text(m[1]), text(m[2])] as const);
  const creators: StatedCreator[] = [];
  let unknownRole: string | undefined;
  let title = "";
  const langs: string[] = [];
  let orig: string | null = null;
  let copyright = "";
  for (const [k, v] of rows) {
    const key = k.toLowerCase();
    if (key === "title") title = v;
    else if (key === "language") langs.push(v);
    else if (key === "original publication") orig = v;
    else if (key === "copyright status" || key === "copyright") copyright = v;
    else if (ROLE_OF[key]) {
      const p = gutenbergPerson(v);
      creators.push({ name: p.name, role: ROLE_OF[key], deathYear: p.deathYear });
    } else if (
      !/^(uniform title|alternate title|note|contents|subject|loc class|loc call number|category|ebook-no\.|release date|most recently updated|last update|downloads|price|reading level|credits|series|isbn.*|language|summary|original publication|copyright status)$/.test(
        key,
      ) &&
      /^[a-z ,.]+$/.test(key) &&
      /\d{3,4}\s*-|-\s*\d{3,4}/.test(v)
    ) {
      // A person in a role we do not know (dates in the value): refuse rather than guess.
      unknownRole = k;
    }
  }
  if (!title) return null;
  const pub = orig ? originalPublication(orig) : { year: null, country: null };
  const author = creators.find((c) => c.role === "author")?.name ?? creators[0]?.name ?? "";
  return {
    link: { host: "gutenberg", id },
    title: title.replace(/\s+/g, " ").trim(),
    author,
    lang: langs.length === 1 ? languageCode(langs[0]) : null,
    creators,
    firstPublicationYear: pub.year,
    workCountry: pub.country,
    usPublicDomain: /public domain in the usa/i.test(copyright),
    translation: creators.some((c) => c.role === "translator"),
    ...(unknownRole ? { unknownRole } : {}),
    source: {
      page: `https://www.gutenberg.org/ebooks/${id}`,
      file: `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`,
      format: "gutenberg-html",
      name: "Project Gutenberg",
    },
    licence:
      "Public domain in the USA. Distributed under the Project Gutenberg License (www.gutenberg.org/policy/license.html).",
    attribution: `Project Gutenberg eBook #${id} (www.gutenberg.org), transcribed by its volunteers.`,
  };
}

const AOZORA_ROLE: Readonly<Record<string, CreatorRole>> = {
  著者: "author",
  翻訳者: "translator",
  編者: "editor",
  編集者: "editor",
  校訂者: "editor",
  監修者: "editor",
  挿絵: "illustrator",
};

/** An Aozora Bunko card → the facts it states (people with 没年, 初出, the XHTML file). */
export function aozoraFacts(
  link: Extract<BookLink, { host: "aozora" }>,
  html: string,
): WorkFacts | null {
  const field = (label: string, from = html) => {
    const re = new RegExp(
      `<td[^>]*class="header"[^>]*>\\s*${label}[：:]?\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    );
    const m = re.exec(from);
    return m ? text(m[1]) : null;
  };
  const title = field("作品名");
  if (!title) return null;
  // One table per person: 分類 (role), 作家名, 没年.
  const people = [
    ...html.matchAll(/<table[^>]*summary="作家データ"[^>]*>([\s\S]*?)<\/table>/g),
  ].map((m) => m[1]);
  const creators: StatedCreator[] = [];
  let unknownRole: string | undefined;
  for (const p of people) {
    const role = field("分類", p) ?? "";
    const name = (field("作家名", p) ?? "").replace(/\s+/g, "");
    const died = field("没年", p);
    const year = died ? /(-?\d{3,4})/.exec(died) : null;
    const r = AOZORA_ROLE[role];
    if (!r) unknownRole = role || "?";
    else creators.push({ name, role: r, deathYear: year ? Number(year[1]) : null });
  }
  const first = field("初出");
  const firstYear = first ? /(\d{4})/.exec(first) : null;
  const file = /href="(\.\/files\/\d+_\d+\.html)"/.exec(html)?.[1];
  if (!file) return null;
  const base = field("底本") ?? "";
  // The 底本's publisher: the first 出版社 on the card (the 親本's comes after).
  const publisher = field("出版社") ?? "";
  const input = [...html.matchAll(/入力[：:]\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    text(m[1]),
  );
  const proof = [...html.matchAll(/校正[：:]\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    text(m[1]),
  );
  const credits = [
    input.length ? `入力：${input.join("、")}` : "",
    proof.length ? `校正：${proof.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("、");
  const page = `https://www.aozora.gr.jp/cards/${link.person}/card${link.card}.html`;
  // Aozora marks a work still in copyright on its card; such a card is never a candidate.
  const protectedWork = /著作権存続/.test(html);
  return {
    link,
    title,
    author: creators.find((c) => c.role === "author")?.name ?? "",
    lang: "ja",
    creators,
    firstPublicationYear: firstYear ? Number(firstYear[1]) : null,
    // 初出 on an Aozora card is a Japanese publication (a magazine, a publisher):
    // the country is stated by where it appeared, not guessed from the language.
    workCountry: firstYear ? "JP" : null,
    ...(protectedWork ? { usPublicDomain: false } : {}),
    translation: creators.some((c) => c.role === "translator"),
    ...(unknownRole ? { unknownRole } : {}),
    source: {
      page,
      file: new URL(file, page).toString(),
      format: "aozora-xhtml",
      name: "青空文庫 Aozora Bunko",
    },
    licence:
      "Public domain (著作権保護期間満了). Aozora Bunko (www.aozora.gr.jp) asks that its input and proofreading volunteers be credited.",
    attribution: `青空文庫 (www.aozora.gr.jp)。底本：「${base}」${publisher}。${credits}。`,
  };
}

// ── Wikisource: the page's Wikidata item ────────────────────────────────────

interface WdClaim {
  mainsnak?: {
    datavalue?: { value?: unknown };
  };
  rank?: string;
}
interface WdEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  claims?: Record<string, WdClaim[]>;
}

const claims = (e: WdEntity | undefined, p: string) =>
  (e?.claims?.[p] ?? [])
    .filter((c) => c.rank !== "deprecated")
    .map((c) => c.mainsnak?.datavalue?.value);
const itemIds = (e: WdEntity | undefined, p: string) =>
  claims(e, p)
    .map((v) => (v as { id?: string } | undefined)?.id)
    .filter((x): x is string => typeof x === "string" && /^Q\d+$/.test(x));
/** A Wikidata time to a year, only when stated to the year or better (precision ≥ 9). */
const yearOf = (v: unknown): number | null => {
  const t = v as { time?: string; precision?: number } | undefined;
  if (!t?.time || (t.precision ?? 0) < 9) return null;
  const m = /^([+-]\d{1,6})-/.exec(t.time);
  return m ? Number(m[1]) : null;
};

/** Facts for a Wikisource page from its Wikidata item (edition → its work), people's death years. */
export async function wikisourceFacts(
  link: Extract<BookLink, { host: "wikisource" }>,
  get: (url: string) => Promise<string>,
): Promise<WorkFacts | null> {
  const api = `https://${link.site}/w/api.php?action=query&format=json&formatversion=2&prop=pageprops%7Crevisions&rvprop=ids&redirects=1&titles=${encodeURIComponent(link.title)}`;
  const q = JSON.parse(await get(api)) as {
    query?: {
      pages?: {
        title: string;
        missing?: boolean;
        pageprops?: { wikibase_item?: string };
        revisions?: { revid: number }[];
      }[];
    };
  };
  const page = q.query?.pages?.[0];
  if (!page || page.missing || !page.revisions?.[0]) return null;
  const rev = page.revisions[0].revid;
  const title = page.title;
  const entities = async (ids: string[]) => {
    if (!ids.length) return new Map<string, WdEntity>();
    const j = JSON.parse(
      await get(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims%7Clabels&ids=${ids.slice(0, 40).join("%7C")}`,
      ),
    ) as { entities?: Record<string, WdEntity> };
    return new Map(Object.entries(j.entities ?? {}));
  };
  const lang = WIKISOURCE_SITES[link.site];
  const qid = page.pageprops?.wikibase_item;
  let creators: StatedCreator[] = [];
  let firstYear: number | null = null;
  let country: string | null = null;
  let translation = false;
  if (qid) {
    const own = (await entities([qid])).get(qid);
    const workId = itemIds(own, "P629")[0];
    const work = workId ? (await entities([workId])).get(workId) : own;
    const roles: [string, CreatorRole][] = [
      ["P50", "author"],
      ["P655", "translator"],
      ["P98", "editor"],
      ["P110", "illustrator"],
    ];
    const people = new Map<string, CreatorRole>();
    for (const e of [work, own])
      for (const [p, role] of roles)
        for (const id of itemIds(e, p)) if (!people.has(id)) people.set(id, role);
    translation = itemIds(own, "P655").length > 0 || itemIds(work, "P655").length > 0;
    const years = [work, own]
      .flatMap((e) => claims(e, "P577").map(yearOf))
      .filter((y): y is number => y !== null);
    // The earliest stated publication of the work (or of this edition, when the work has none).
    firstYear = years.length ? Math.min(...years) : null;
    const countryIds = itemIds(work, "P495").concat(itemIds(own, "P495"));
    const looked = await entities([...people.keys(), ...countryIds.slice(0, 1)]);
    creators = [...people].map(([id, role]) => {
      const e = looked.get(id);
      const deaths = claims(e, "P570").map(yearOf);
      // Two different stated death years: uncertain, so none.
      const known = [...new Set(deaths.filter((y): y is number => y !== null))];
      const name = e?.labels?.[lang]?.value ?? e?.labels?.en?.value ?? id;
      return { name, role, deathYear: known.length === 1 ? known[0] : null };
    });
    const c = countryIds[0] ? looked.get(countryIds[0]) : undefined;
    const iso = claims(c, "P297")[0];
    country = typeof iso === "string" ? iso.toUpperCase() : null;
  }
  const t = title.replace(/ /g, "_");
  return {
    link: { ...link, title },
    title: title.replace(/\s*\([^)]*\)\s*$/, ""),
    author: creators.find((c) => c.role === "author")?.name ?? "",
    lang,
    creators,
    firstPublicationYear: firstYear,
    workCountry: country,
    translation,
    source: {
      page: `https://${link.site}/wiki/${encodeURI(t)}`,
      file: `https://${link.site}/api/rest_v1/page/html/${encodeURIComponent(t)}/${rev}`,
      format: "wikisource-html",
      name: "Wikisource",
    },
    licence:
      "Public domain (the work). Wikisource's transcription is shared under CC BY-SA 4.0 (creativecommons.org/licenses/by-sa/4.0).",
    attribution: `Wikisource (${link.site}), "${title}", revision ${rev}, transcribed by its contributors.`,
  };
}

/** The facts for a link, read from its host (Gutenberg's page, Aozora's card, Wikidata). */
export async function readFacts(
  link: BookLink,
  get: (url: string) => Promise<string>,
): Promise<WorkFacts | null> {
  if (link.host === "gutenberg")
    return gutenbergFacts(link.id, await get(`https://www.gutenberg.org/ebooks/${link.id}`));
  if (link.host === "aozora") return aozoraFacts(link, await get(linkPage(link)));
  return wikisourceFacts(link, get);
}

/** A curated entry is checked by the same rule for the viewer; the facts are its own. */
export function judgeEntry(b: CatalogueBook, viewerCountry: string | null, year: number): Verdict {
  if (!pdIn(b, "US", year)) return { ok: false, reason: "not-public-domain-us" };
  if (!pdIn(b, b.workCountry, year)) return { ok: false, reason: "not-public-domain-origin" };
  if (!pdIn(b, viewerCountry, year))
    return { ok: false, reason: "not-public-domain-here", detail: viewerCountry ?? "" };
  return { ok: true, book: b, curated: true };
}
