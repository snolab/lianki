# Word lists — the same server pipeline as books

Status: **concept only, nothing built** (2026-10-31). Owner, Slack,
2026-10-31 about 00:2x JST: "词库继续扩充也按这个形式". Growing the word lists
follows the books model ([books-concept.md](books-concept.md)): open sources
only, fetched, cached and preprocessed on the server, never committed to the
repo; users add lists from the UI through the same pipeline and licence
check; attribution at add time and on every card.

> 中文摘要：词库和书库一样走服务端管线：接入所有开放来源（词频表、JLPT/HSK/CEFR 词表、维基词典、
> JMdict、CC-CEDICT、Tatoeba 等，各自注明许可），服务端按需抓取、R2 缓存、预处理（分词、假名读音和拼音、
> 例句匹配、分级），词表不进仓库。用户可在界面上用链接、CSV 或搜索来源添加词表，同样做许可检查。添加时
> 显示来源，之后每张卡按字段注明出处（释义来自哪里、例句来自哪里）。现有 62 个内置词表按原 id 迁到
> 服务端，用户的卡和复习记录不受影响，已渲染的语音键不变、不用重做。AnkiWeb 共享卡组只许个人使用、禁止爬取，所以不做服务端抓取，改为引导用户自己下载 .apkg 再导入（私有词表，每张卡注明卡组和作者）。约 35 个 agent 小时，和书库共用的部分不重复算。

## 1. Sources and licences

A list is built from up to four kinds of data: **ranks** (frequency), **levels**
(JLPT, HSK, CEFR), **dictionary** data (gloss, reading, part of speech) and
**examples** (sentences). Each source is an adapter, as for books
(`lib/books/sources/*` and `lib/wordlists/sources/*` share the interface,
the fetch limiter and the licence verdicts).

Verdicts as in books section 2: **open** (shared lists may use it),
**non-commercial** (not used until the owner decides; Lianki sells Pro
passes), **unclear** (private use only, after the user confirms), **closed**
(no adapter).

### Frequency

| Source                                         | Languages | Licence                                              | Notes                                                                                                                 |
| ---------------------------------------------- | --------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| hermitdave/FrequencyWords (OpenSubtitles 2018) | ~60       | Lists **CC BY-SA 4.0**, code MIT                     | In use today for de, en, es, fr, it, ko, pt, ru and ja ordering. Only counts; subtitles themselves are never fetched. |
| wordfreq (rspeer) data                         | ~40       | Data **CC BY-SA 4.0**, code Apache 2.0               | Blends several corpora (Wikipedia, subtitles, books, web); frozen in 2024 but the best multi-genre ranks.             |
| Leipzig Corpora Collection                     | 250+      | Stated per download; historically **non-commercial** | Verify per corpus before use; until then non-commercial.                                                              |
| SUBTLEX (en-US, de, nl, zh, es, …)             | several   | Research releases, terms vary                        | Unclear: not for shared lists unless a release states an open licence.                                                |
| Wikipedia word counts (from the dumps)         | all       | Text **CC BY-SA 4.0**                                | We can count ourselves; heavy (section 2).                                                                            |
| Our own book corpus                            | as books  | counts from public-domain texts                      | Ranks for literary vocabulary, free of any licence.                                                                   |

### Levels

| Source                                                                                      | Lang                               | Licence                                                                                             | Notes                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| JLPT lists by Jonathan Waller (tanos.co.uk), via jamsinclair/open-anki-jlpt-decks           | ja                                 | **CC BY** (data), MIT (code)                                                                        | In use. Unofficial: JLPT has published no list since 2010.                                                                                      |
| HSK 2.0 (1–6) and HSK 3.0 (GF 0025-2021, levels 1–9) lists                                  | zh                                 | Official lists from the Chinese standards bodies; the GitHub transcriptions carry MIT or no licence | In use (HSK 1–6). Copyright on a government standard is not settled: treat the transcription's licence as the verdict, and flag ones with none. |
| CEFR-J Wordlist (Tokyo University of Foreign Studies)                                       | en                                 | Free with citation; check its commercial clause                                                     | A–B levels for English.                                                                                                                         |
| Kelly lists (9 languages, CEFR-tagged)                                                      | ar, el, en, it, nb, pl, ru, sv, zh | **CC BY-NC-SA**                                                                                     | Non-commercial.                                                                                                                                 |
| FLELex / SVALex / EFLLex (CEFR from textbooks)                                              | fr, sv, en                         | **CC BY-NC-SA**                                                                                     | Non-commercial.                                                                                                                                 |
| National Institute of Korean Language learner vocabulary (한국어 학습용 어휘)               | ko                                 | Government publication; KOGL type stated per item                                                   | Use if KOGL type 1.                                                                                                                             |
| English Vocabulary Profile, Oxford 3000/5000, Goethe-Institut and Instituto Cervantes lists | en, de, es                         | All rights reserved                                                                                 | **No adapter.** Levels for these languages come from frequency bands (books section 4).                                                         |

### Dictionaries

| Source                              | Lang          | Licence                                                                                                                           | Notes                                                                                                                           |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Wiktionary, via kaikki.org extracts | every edition | **CC BY-SA 4.0** (and GFDL)                                                                                                       | In use (English glosses). Other editions (fr, de, ja, zh, …) give glosses in other UI languages.                                |
| JMdict / EDICT, KANJIDIC2 (EDRDG)   | ja            | **CC BY-SA 4.0**, with the EDRDG's attribution requirement: a statement naming the EDRDG and linking its licence page, in the app | Readings, glosses in several languages, part of speech. Updated daily upstream; we fetch a release only when a build needs one. |
| CC-CEDICT                           | zh            | **CC BY-SA 4.0**                                                                                                                  | Pinyin with tones, English glosses; HanDeDict (de) and CFDICT (fr) are CC BY-SA too.                                            |
| Unihan (Unicode)                    | zh, ja, ko    | Unicode licence (permissive)                                                                                                      | Character readings, fallback for pinyin and on/kun.                                                                             |
| UniDic / IPADIC                     | ja            | BSD-style (IPADIC); UniDic triple-licensed GPL / LGPL / BSD (take BSD)                                                            | Lemmas and readings for segmentation.                                                                                           |
| Open Multilingual Wordnet           | many          | Per wordnet; most open (CC BY, CC BY-SA)                                                                                          | Synonyms and senses, phase 2.                                                                                                   |

### Example sentences

| Source                             | Licence                     | Notes                                                                                                                                                                |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tatoeba sentences                  | **CC BY 2.0 FR** (some CC0) | In use. Attribution names Tatoeba and links the sentence id. **Audio** is licensed per contributor (some CC BY-NC, some no reuse): only clips whose licence is open. |
| Wiktionary usage examples          | CC BY-SA 4.0                | In use.                                                                                                                                                              |
| Sentences from public-domain books | public domain               | From the books pipeline; the example carries the book's `src`.                                                                                                       |
| JMdict example (Tanaka corpus)     | now part of Tatoeba         | Take it from Tatoeba.                                                                                                                                                |
| OpenSubtitles lines, news corpora  | copyrighted text            | **No examples** from these; counts only.                                                                                                                             |

### Ready-made decks

| Source                                                   | Licence                                                                                                      | Notes                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [AnkiWeb shared decks](https://ankiweb.net/shared/decks) | **Personal use only** (AnkiWeb terms, "Shared Decks"), unless a deck's author grants more in its description | **No server fetch, no crawl.** The user downloads the `.apkg` and imports it into a private list: section 3a. |

## 1a. AnkiWeb shared decks: the licence finding

Checked 2026-10-31 against the live terms (ankiweb.net/account/terms) and
robots.txt:

- **The licence a downloader gets is personal.** "When you download a deck
  that someone has shared, the deck author grants you a permanent,
  non-revocable, worldwide, royalty free, non-exclusive license to use the
  material in your personal studies. This license is for personal use only,
  and the deck may not be redistributed, re-uploaded, published, or used for
  any other purposes without explicit permission from the copyright holder."
  A shared Lianki list built from a deck would be redistribution.
- **Authors may grant more**, "by specifying so in your deck's description,
  such as allowing them to redistribute modified versions"; AnkiWeb lets
  them add rights, never restrictions. So a deck is shareable only when its
  description says so (for example a CC licence). Rare, and read per deck by
  a person, not by a parser.
- **The content's own rights are unknown.** Uploaders assert the deck is their
  own work or licensed, but AnkiWeb says it does not check ("we do not have
  the resources to manually check decks"). Many popular language decks copy
  textbook vocabulary, example sentences and audio (Genki, Core 2k/6k from
  iKnow, commercial TTS). Even with the author's permission, their right to
  grant it is doubtful.
- **Automated access is excluded.** robots.txt disallows `/shared/decks/`,
  `/shared/download` and `/shared/downloadDeck` for every user agent, and the
  terms allow access "directly through your browser" and the approved Anki
  clients only: "AnkiWeb does not currently allow access from browser
  extensions or other third-party clients."

**Recommendation:** no AnkiWeb adapter; never fetch, search or mirror AnkiWeb
from the server, and never put deck content on the shared shelf. The safe and
useful path is the one Lianki already has: the user downloads a deck in their
own browser and imports the `.apkg` into a **private** list (`/words/import`
parses it on the device; only the entries reach the server). That is the
personal use the licence grants, with attribution kept on every card.

## 3a. The guided AnkiWeb import

On /words → "Add a list" → **From an Anki deck**:

1. **Find a deck on AnkiWeb.** Lianki opens AnkiWeb in a new tab; nothing is
   fetched by Lianki. A search box builds the link
   `https://ankiweb.net/shared/decks?search=<terms>` (AnkiWeb's own search
   URL), prefilled with the study language and a topic chip (vocabulary, JLPT
   N3, HSK 4, grammar, phrases). The user browses, opens a deck's page
   (`/shared/info/<id>`) and downloads it there.
2. **Paste the deck's page link** (optional but asked for): Lianki only
   parses the id from the URL, it does not open it. The user can also type the
   author's name and pick the licence, defaulting to "AnkiWeb shared deck:
   personal use" (or "the description grants: …" with a free-text field).
3. **Pick the downloaded `.apkg`** in the existing importer (field mapping,
   language, target list). The note on the sheet: "For your personal study.
   Imported decks stay private to your account."
4. **The list** gets `source` `anki:<deckId>` as today, and the deck's
   attribution (`{source: "ankiweb", deckId, url, title, author, licence:
"personal use"}`) is stored on the list and on every entry's `src`.
   Every card shows "Deck: <title> by <author> · AnkiWeb (personal use)",
   linking to the deck's page.
5. **Private, always**: the list never joins the shelf, its clips are
   generated per user (rate-limited misses, not pre-rendered for others), and
   the pipeline may only add open data to it (a missing reading from JMdict, an
   example from Tatoeba), each with its own `src`. Re-importing a newer
   version of the deck updates the list in place, as today.

Without a pasted link, the deck's own name and id (from the `.apkg`) are the
attribution, with "source link unknown".

## 2. Server-side fetch, cache, preprocess

Same machinery as books section 3: adapters, the LiankiBot User-Agent,
robots, a per-host limiter, R2 cache, a Cloudflare Queue, no polling, no
cron.

- **Dumps are fetched once per release, on demand.** Wiktionary extracts,
  JMdict and CC-CEDICT are published as downloads meant to be taken whole.
  We fetch one when a build needs it and the cached copy is older than its
  release, never on a timer; "update from source" re-runs it. The large ones
  (a kaikki extract is hundreds of MB) are streamed into R2 and indexed by
  lemma there (a sharded `dict/<lang>/<source>/<prefix>.json`), so a list
  build reads only the lemmas it needs. The streaming and indexing run where
  a Worker's memory is enough per shard; the first pass of a big dump may
  need the same small container as the ja/zh tokenizers.
- **Building a list** (a queue job per list, chunked by 500 entries):
  1. Terms from the list source (ranks, a level list, a user CSV).
  2. **Segmentation and lemmas**: inflected forms folded to lemmas (kaikki
     form tables; the ja analyser; jieba for zh), duplicates merged.
  3. **Readings**: ja kana from JMdict, else the analyser; zh pinyin with tone
     marks from CC-CEDICT by word (so 银行 is yínháng, not yínxíng), else
     Unihan per character; ko romanisation optional.
  4. **Glosses** in the user's UI language: that language's Wiktionary
     edition first, then the English one; a machine translation fallback is
     marked as machine.
  5. **Example matching**: candidate sentences that contain the lemma (by
     lemma, not by string), from Tatoeba, Wiktionary and the book corpus;
     ranked by length (short), by how many of their other words sit at or
     below the list's level, and by having a translation; one kept, its
     translation alongside.
  6. **Grading**: rank and level per entry; the list's level band.
  7. **Clip plan**: term, gloss and example keys (`voiceKey`), so prefetch
     and pre-rendering know what to voice.
- **Output** is the catalog shape /words reads today
  (`{id, lang, name, level, source, license, entries: [{term, back, reading, ex, exTr}]}`)
  plus `src` per field (section 4), at `lists/<id>.json` in R2 behind the
  same public, edge-cached Worker route as shared books. Lists are not in the
  repo.

## 3. Adding a list from the UI

/words → "Add a list" (a glass sheet), three ways in:

- **Search the sources**: "JLPT N2", "HSK 4", "Spanish top 3000", "French
  CEFR B1"; results grouped by source with a verdict chip and size.
- **Paste a link** to a list on a known source (a GitHub CSV in a known repo,
  a Wiktionary frequency appendix, a Tatoeba list). Unknown hosts are refused
  with the list of sources that work, as for books.
- **Upload a CSV / TSV** (term, and optionally reading, meaning, example).
  Anki `.apkg` stays on the existing import (`/words/import`). An uploaded
  file is the user's own: its verdict is **private** (their list only, never
  shared), and the pipeline fills in what is missing (reading, gloss,
  example, level) from open sources, each with its own `src`.

Before adding, the sheet shows the attribution block: name, source and link,
licence, the dictionary and example sources the build will use, and the
verdict. Non-commercial or closed sources show the reason and no Add button.
Adding answers at once and streams progress on that response (SSE), the
first 50 entries first so studying can start in seconds.

## 4. Attribution on every card

Each entry stores where each part came from:

```json
"src": {
  "term": "jlpt-tanos",
  "back": {"source": "jmdict", "licence": "CC BY-SA 4.0"},
  "ex": {"source": "tatoeba", "id": 12345, "licence": "CC BY 2.0 FR"}
}
```

(a `src` JSON column on `word_list_entries`, the same one the books concept
adds; shared lists carry it in their R2 file). The source registry
(`lib/wordlists/sources.ts`) turns ids into names, links and licence texts.

- **On the card** (/words row and swipe card): a one-line source under the
  example, e.g. "JMdict · Tatoeba #12345", tappable to the sentence's page and
  the licence; a card from a book shows the book instead.
- **About page**: the full list of sources with their required statements
  (the EDRDG statement for JMdict and KANJIDIC2, Tatoeba, CC-CEDICT,
  Wiktionary, FrequencyWords).
- **Exports**: the Anki export (`lib/words/apkg.ts`) adds a Source field;
  CC BY-SA content keeps its licence line (ShareAlike travels with it).

## 5. Today's bundled lists, and the migration path

Today: 62 lists in `public/words/*.json` (frequency bands for de, en, es,
fr, it, ko, pt, ru; JLPT N5–N1; HSK 1–6) plus `index.json` and
`SOURCES.md`, built locally by `scripts/words/build-word-lists.ts` from
downloads in a scratch dir; the client loads them through
`lib/words/catalog-cache.ts` (IndexedDB, stale-while-revalidate); their
clips are pre-rendered with open voices (`lib/voice.ts`, `scripts/voice`),
kept in R2 and served by `workers/voice`.

Migration, in order, with nothing breaking for anyone mid-way:

1. **Move the build into the pipeline.** The logic of
   `build-word-lists.ts` and `filter-kaikki.ts` becomes the shared modules
   (`lib/wordlists/*`); the script stays as a local runner of the same
   modules for development.
2. **Rebuild the 62 lists on the server with their current ids**
   (`de-freq-1`, `ja-jlpt-n3`, …). A golden test diffs each against today's
   file; differences are only the new `src` fields (or are explained).
3. **Same ids, same terms, so users' cards and reviews do not move**: word
   cards are keyed by list id and term.
4. **Switch the catalog path**: `catalog-cache.ts` loads
   `/lists/<id>.json` from the edge route instead of `/words/<id>.json`.
   The IndexedDB cache is keyed by path, so the first open refetches once;
   offline users keep their old copy until then.
5. **Voices are untouched.** Clip keys come from language and text
   (`voiceKey`), not from where the list file lives, so every pre-rendered
   recording in R2 still matches and nothing is re-rendered. New lists'
   clips: generated on first play (MeloTTS) as today, and pre-rendered in
   batches when a list proves popular.
6. **Keep `public/words/` for one release** as a fallback the client tries on
   an edge miss, then delete it and `SOURCES.md` moves into the source
   registry and the about page.
7. **Users' imported lists** (`anki:` sources in `word_list_entries`) need no
   change; they gain `src` when the pipeline fills in a missing field.

## 6. Estimates (agent hours)

Shared with books (adapters' interface, limiter, R2 route, licence verdicts,
`src` column and card source line, SSE progress) are counted there once.

| #   | Piece                                                                                                           | Agent hours |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Adapters: FrequencyWords, wordfreq, kaikki (any edition), JMdict, CC-CEDICT, Unihan, Tatoeba, JLPT (tanos), HSK | 8           |
| 2   | Dump fetch and R2 lemma shards (streamed; container for the first pass if needed)                               | 4           |
| 3   | List build queue: lemmas, readings and pinyin, glosses per UI language                                          | 5           |
| 4   | Example matching and grading                                                                                    | 3           |
| 5   | Add a list: search, link, CSV upload, attribution block                                                         | 4           |
| 6   | Per-field `src`, source registry, about page statements, Anki Source field                                      | 2           |
| 6a  | Guided AnkiWeb import: search link builder, deck link + author fields, attribution on list and cards            | 2           |
| 7   | Migration of the 62 lists: golden diff, catalog path switch, fallback, then removal                             | 4           |
| 8   | QA with fixture dumps (no live fetches in tests), i18n, docs                                                    | 3           |
|     | **Total**                                                                                                       | **≈ 35**    |

Runs as its own lane alongside books once the shared pieces land. Questions
for the owner: whether non-commercial sources (Kelly, FLELex, Leipzig) may be
used at all, and which new lists come first.
