# Books — public-domain classics to read, hear and mine for cards

Status: **concept only, nothing built** (revised 2026-10-31). Owner request,
voice, 2026-10-30 23:49–23:50 JST: preload learning content, namely
public-domain books (classics) in each language, linked to /words (tap a word
to add a card). UX first. Owner's reply, 2026-10-31 00:18 JST:

> 书库来源尽量扩充所有可能的来源，做服务端抓取缓存的形式，书不进仓库。但允许界面上直接添加，
> 我们服务端做抓取加缓存加书籍预处理，比如分词分句之类的。添加时和之后卡盒都要注明来源。

> 中文摘要：书库接入所有能合法使用的公版 / 开放许可来源（古腾堡及镜像、Standard Ebooks、青空文库、
> 各语种维基文库、Internet Archive、Runeberg、DTA、漢籍リポジトリ 等，每个来源写明许可和自动抓取规则）。
> 书不进仓库：服务端按需抓取、存 R2 缓存、预处理（分句、日中分词、词频分级、朗读切片计划），遵守
> robots 和限速，不轮询。用户可以在界面上直接加书（贴链接或搜索来源），走同一条管线并做版权检查：
> 确认公版的进公共书库，确认在版权内的拒绝，判断不了的标出来、只给本人私用。来源处处注明：添加时显示
> 来源、作者、许可、链接；之后每张从书里做的卡都存并显示出处。MVP 约 57 个 agent 小时（并行约 20–24）；
> 先做一小片约 20 个 agent 小时。

**What I understood, to be corrected** (section 12 has the questions left
open):

1. The shelf is **server-side**: Lianki keeps a catalog of references (source
   - id), fetches a book's text when someone first opens or adds it, and caches
     the fetched and preprocessed result in R2. No book text is ever committed.
2. Users add books themselves, by URL or by searching the sources, through
   the same pipeline.
3. "Linked to /words": a tapped word becomes a card in a /words list, with
   the book's sentence as its example. Every such card carries and shows its
   source.
4. "State tree" = the user's own tree of generic nodes (as the calendar plan
   proposes for `/plan`), not the public dev tree in `docs/state-tree.md`.

## 1. Sources

Each source is an **adapter** (`lib/books/sources/<name>.ts`) with four
functions: `search(q, lang)`, `resolve(url) → ref`, `fetch(ref) → raw` and
`meta(ref) → {title, author, lang, published, authorDied, licence, flags}`.
The server fetches **only** from hosts an adapter knows, never from an
arbitrary URL (that also rules out SSRF). A web page that is not a book stays
what it is today: a page card through the userscript.

"Bulk" below means whole-catalogue downloads; we never do that. We fetch one
work when a user opens or adds it, plus the source's own catalogue/index file
where one exists for search.

### General, many languages

| Source                                                                                                                       | Text licence                                                                                                                                                                                                                                                                                                          | Automated fetching                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Project Gutenberg](https://www.gutenberg.org) (en, fr, de, fi, nl, it, pt, es, zh, …; ~75 000 works)                        | Public domain in the US. "Project Gutenberg" is a trademark: copies that keep the PG header and name fall under its licence (royalty on commercial use). We strip the header, footer and every mention of PG, which leaves a plain public-domain text, and credit "from Project Gutenberg ebook #N" in our own words. | Its site forbids crawlers; humans only. Machines use **mirrors** (the rsync / HTTP mirror list, e.g. `aleph.gutenberg.org`) for files, and the **catalogue feed** `gutenberg.org/cache/epub/feeds/pg_catalog.csv` (and the RDF) for search. Gutendex (a third-party JSON API over the catalogue) is optional for search only. PG judges by US law; we apply section 2 on top. |
| PG mirrors with other rules: Project Gutenberg Australia, Faded Page (Canada), Projekt Gutenberg-DE                          | PG Australia and Faded Page publish works that are public domain **in their own country** (often life + 50), many still protected in the US and EU. Projekt Gutenberg-DE (spiegel.de) is not free to copy at all.                                                                                                     | PG-AU / Faded Page: adapter allowed, but every item goes through section 2 and most later works will be flagged. Projekt Gutenberg-DE: **no adapter**.                                                                                                                                                                                                                        |
| [Standard Ebooks](https://standardebooks.org) (en)                                                                           | US public domain texts; their own work (markup, typography, proofreading) dedicated **CC0**.                                                                                                                                                                                                                          | Per-book EPUB downloads are free; their bulk downloads and full OPDS feed are for paying patrons. Each book's source is a public GitHub repo (`standardebooks/<slug>`), which we fetch per book. Best English edition: preferred over PG when both have the book.                                                                                                             |
| [Wikisource](https://wikisource.org), **every language** (~75 subdomains: zh, fr, de, ru, es, it, pt, pl, ja, ko, ar, he, …) | The works are public domain; text added by editors (annotations, translations) is **CC BY-SA 4.0** (and GFDL on older pages). A translation into another language is CC BY-SA if a Wikisource editor made it, otherwise it has its own status.                                                                        | MediaWiki Action API (and the `ws-export` EPUB service), with a descriptive User-Agent, `maxlag`, one request at a time per wiki, as the Wikimedia API etiquette asks. Licence facts come from **Wikidata**: author death date (P570), publication date (P577), copyright status (P6216).                                                                                     |
| [Internet Archive](https://archive.org) texts                                                                                | Mixed. Items marked public domain (`licenseurl` PD mark, `possible-copyright-status`) or old enough; anything else is in copyright, including most of its lending library and Open Library.                                                                                                                           | `advancedsearch` and `metadata` APIs; text from the item's plain-text or EPUB derivative. Rate-limited per item; their terms allow access, not redistribution of in-copyright items. OCR text is noisy: flagged "OCR" with a quality score (share of dictionary words).                                                                                                       |
| [HathiTrust](https://www.hathitrust.org) full-view                                                                           | Public domain items; Google-digitised ones carry a request for non-commercial use.                                                                                                                                                                                                                                    | Data API per volume; bulk only through their research datasets. Phase 2, and only non-Google items unless you accept the request.                                                                                                                                                                                                                                             |
| [LibriVox](https://librivox.org) (audio, many languages)                                                                     | Recordings dedicated to the **public domain**; the texts read are US public domain.                                                                                                                                                                                                                                   | JSON API plus MP3s on archive.org, per book. For section 6 (phase 2).                                                                                                                                                                                                                                                                                                         |

### Per language

| Lang                        | Source                                                                                | Text licence                                                                                                                                                                           | Automated fetching                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ja                          | [青空文庫 Aozora Bunko](https://www.aozora.gr.jp) (~17 000)                           | Works with `作品著作権フラグ` = なし are public domain; Aozora asks nothing for them (commercial use included). Works with あり are in copyright, posted with the author's permission. | GitHub mirror `aozorabunko/aozorabunko` (per file, not a clone) and the index `list_person_all_extended_utf8.csv` for search. Keep the 底本 and 入力・校正 credits. Prefer 新字新仮名 editions; ruby `《》` gives furigana. あり: refused. |
| ja                          | 国立国会図書館デジタルコレクション (NDL)                                              | Items marked インターネット公開 (保護期間満了) are public domain; their OCR full text (NDL Lab) may be reused.                                                                         | NDL Search / Digital Collection APIs, per item; OCR text flagged "OCR". Phase 2.                                                                                                                                                           |
| zh (classical)              | [漢籍リポジトリ Kanseki Repository](https://www.kanripo.org) (~9 000 classical texts) | Texts **CC BY-SA 4.0**; the works themselves are ancient.                                                                                                                              | Per-text GitHub repos (`kanripo/KR…`). The preferred source for 文言文.                                                                                                                                                                    |
| zh (classical)              | [中國哲學書電子化計劃 CText](https://ctext.org)                                       | Works public domain, but the site's terms bar commercial use and bulk download; its API needs a key and is rate-limited.                                                               | **Search and cross-reference only** (find the work, then fetch it from Wikisource or Kanripo). No text from CText unless they grant us permission.                                                                                         |
| zh (modern)                 | zh.wikisource                                                                         | as Wikisource                                                                                                                                                                          | 鲁迅, 胡适, 朱自清 and the like.                                                                                                                                                                                                           |
| zh (Buddhist)               | CBETA                                                                                 | CC BY-NC-SA                                                                                                                                                                            | Non-commercial: flagged, see question 3.                                                                                                                                                                                                   |
| de                          | [Deutsches Textarchiv](https://www.deutschestextarchiv.de) (DTA)                      | **CC BY-SA 4.0** (editions); works public domain.                                                                                                                                      | Documented API (TEI, plain text), per work. Original spelling, often old: badge.                                                                                                                                                           |
| de                          | Zeno.org                                                                              | Works public domain; the site claims database rights.                                                                                                                                  | Search only; fetch the same work from DTA, PG or Wikisource.                                                                                                                                                                               |
| fr                          | [Gallica](https://gallica.bnf.fr) (BnF)                                               | Public domain works; BnF's reuse terms: free for **non-commercial** use, commercial reuse needs a BnF licence (fee).                                                                   | SRU and IIIF APIs, OCR text mode. Lianki sells Pro passes, so treat as commercial: **search only** unless we take a licence; fetch the text from fr.wikisource, PG or Bibliothèque numérique romande instead.                              |
| fr                          | [Bibliothèque numérique romande](https://ebooks-bnr.com)                              | Public domain texts (Swiss life + 70), free to share.                                                                                                                                  | Per-book EPUB downloads; no API.                                                                                                                                                                                                           |
| Nordic (sv, da, no, fi, is) | [Project Runeberg](https://runeberg.org)                                              | Public domain texts, free to copy.                                                                                                                                                     | Per-work pages and its own text files, slowly; it asks for no mass mirroring without contact.                                                                                                                                              |
| es                          | Biblioteca Virtual Miguel de Cervantes                                                | Its own terms; reuse limited.                                                                                                                                                          | Search only; text from PG or es.wikisource.                                                                                                                                                                                                |
| it                          | [Liber Liber / Progetto Manuzio](https://www.liberliber.it)                           | Works public domain; their editions carry their own licence per item (check each).                                                                                                     | Per-book downloads; licence read per item, flagged when restrictive.                                                                                                                                                                       |
| pt                          | Domínio Público (Brazil, government portal); Projecto Adamastor (Portugal)            | Public domain.                                                                                                                                                                         | Per-item downloads.                                                                                                                                                                                                                        |
| ru                          | ru.wikisource                                                                         | as Wikisource                                                                                                                                                                          | lib.ru and similar: **no adapter**, not free to copy.                                                                                                                                                                                      |
| ko                          | 공유마당 (gongu.copyright.or.kr)                                                      | Expired-copyright works, and KOGL / CC licences shown per item.                                                                                                                        | Per item; licence read from the item.                                                                                                                                                                                                      |
| he                          | [Project Ben-Yehuda](https://benyehuda.org)                                           | Public domain works, plus works released by their rights holders.                                                                                                                      | Has an API; per-item licence.                                                                                                                                                                                                              |
| ar                          | Hindawi Foundation, ar.wikisource                                                     | Hindawi books are free to download; per-book terms.                                                                                                                                    | Per book; flagged until a book's terms are read.                                                                                                                                                                                           |

Adding a source later is one adapter file plus a row here.

Word lists follow the same model (owner, 2026-10-31): their sources,
pipeline and migration are in [wordlists-pipeline.md](wordlists-pipeline.md).

## 2. Licence check

Every book, on the shelf or added by a user, gets a verdict before its text
is cached for everyone. The check (`lib/books/licence.ts`) takes the
adapter's `meta`, then fills gaps from Wikidata.

**Public domain everywhere we serve** (the default rule) means all of: the
author died 70+ years ago (in 2026: in 1955 or earlier); published before
1931 in the US, or a foreign work out of copyright at home in 1996 (so not
restored by URAA); and the source's own flag agrees (Aozora なし, PG "Public
domain in the USA", IA PD mark). Translations count as new works: only the
original text, or a translation that itself passes, or an editor's
translation under CC BY-SA.

Pitfalls the check knows: France adds up to +30 years for authors "mort pour
la France" (Saint-Exupéry, free in most of the EU, is protected in France
until 2032); Russia adds 4 years for WWII participants; Japan moved to life +
70 on 2018-12-30, not retroactively (died in 1967 or earlier: free); mainland
China and Taiwan are life + 50 (we still apply life + 70); Mexico is life +
100 (not geo-blocked; the takedown address covers it).

**Verdicts:**

| Verdict                                                      | When                                                           | What happens                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public domain**                                            | all of the above, from facts we can cite                       | Cached and preprocessed once, shared on the shelf for everyone, clips may be pre-rendered.                                                                                                                                                                             |
| **Open licence**                                             | CC BY, CC BY-SA, CC0, KOGL type 1, …                           | As public domain, with the licence's attribution carried everywhere (section 5).                                                                                                                                                                                       |
| **Non-commercial** (Gallica, CBETA, HathiTrust Google items) | the source says so                                             | Not fetched until question 3 is answered; listed with the reason.                                                                                                                                                                                                      |
| **Unknown**                                                  | a fact is missing (no death date, no publication year)         | Shown with "licence unverified"; the user may confirm it is public domain where they live, and then reads it as a **private** book: cached for them only, never on the shelf, never pre-rendered. The owner sees a queue of unknowns to verify (no automated retries). |
| **In copyright**                                             | a fact says so (died after 1955, Aozora あり, IA in-copyright) | **Refused**, with the reason in words ("宮本百合子 died in 1951: free" / "the author died in 1970: protected until 2041"). Nothing is fetched.                                                                                                                         |

Every book stores its verdict, the facts behind it and their sources, so a
takedown or a correction is one row. The pre-commit hook needs no change: no
book enters the repo.

## 3. The server pipeline: fetch, cache, preprocess

On demand, cached, event-driven, no polling and no cron.

```
add / first open
  → resolve (adapter)            ref = {source, id, edition}
  → licence check                verdict (section 2)
  → fetch (adapter)              raw text, once, through the host's limiter
  → preprocess (queue consumer)  per chapter
  → R2 books/<bookId>/…          manifest.json, chapters/<n>.json, glossary.json
  → D1 books row: status ready   the client is told (see below)
```

**Fetching politely.**

- One User-Agent, `LiankiBot/1.0 (+https://lianki.com/bot)`, with a page
  that says what we fetch and how to reach us.
- `robots.txt` is read before the first fetch from a host and kept for a day;
  it is read again only when the next fetch comes after that (on demand, not
  on a timer). Disallowed paths are never fetched; `Crawl-delay` is honoured.
- A **per-host limiter** (a Durable Object per host, like the existing
  rate limiter's role): one request at a time, at least the host's delay
  apart (default 2 s; Wikimedia: `maxlag`), backing off on 429/503 with
  `Retry-After`.
- Each work is fetched **once**. The cache is the source of truth afterwards;
  a refetch happens only when someone asks for "update from source". Search
  index files (PG catalogue CSV, Aozora index) are refreshed when a search
  needs them and they are older than a week, not on a schedule.

**Preprocessing** (a Cloudflare Queue, one message per chapter, so a long
book never hits a Worker's CPU limit; the consumer is a Worker):

1. **Clean**: strip PG headers, Aozora annotations (`［＃…］`, keeping ruby
   as readings), Wikisource templates; normalise whitespace and quotes.
2. **Chapters** from the source's own structure (EPUB spine, headings).
3. **Sentences**: `Intl.Segmenter` (`"sentence"`), with per-language fixes
   (Japanese 「」 dialogue kept whole; abbreviations in en/fr/de).
4. **Words**: ja with a morphological analyser (lindera-wasm with IPADIC or
   UniDic, for lemma and reading); zh with jieba (jieba-rs as WASM); others
   with `Intl.Segmenter` (`"word"`) and the form → lemma maps the word-list
   build already makes from the kaikki Wiktionary extracts. Whether the ja/zh
   dictionaries fit the Worker size limit is the first thing to spike; the
   fallback is a small container (Cloudflare Containers) for those two only.
5. **Frequency and grading** (section 4).
6. **Glossary**: every lemma in the book with its gloss from the kaikki
   extracts and the JLPT/HSK lists, so a tap works offline.
7. **TTS clip plan**: each sentence cut into clips of ≤ 200 characters
   (`MAX_TTS_TEXT`), at clause boundaries, with each clip's key (the same
   `voiceKey` as word clips). Clips are **not** generated here: the first
   playback generates each one through `/api/words/tts`, which keeps it in R2
   for everyone. Shared books can later be pre-rendered with the open voices.

Storage: `books` in D1 (catalogue: id, source, source id, lang, title,
author, verdict, facts, level, status, added_by, created_at); text and
derived data in R2 under `books/<bookId>/`, served by a public, edge-cached
Worker route (the `workers/voice` pattern) for shared books, and through an
authenticated route for private ones.

**Telling the client it is ready.** Adding a book answers at once with its
id and status `processing`; the add request then streams progress (SSE on
that same response: fetched, chapter 3 of 40, ready). The first chapter is
processed first, so reading can start after a few seconds. If the stream
drops, reopening the book shows its status; nothing polls.

## 4. Difficulty grading

The problem with classics: most are B2+ for a learner. Grading is what makes
the shelf usable.

- Rank every lemma against the frequency ranks the bundled lists come from
  (hermitdave/FrequencyWords for de/en/es/fr/it/ko/pt/ru; JLPT N5–N1 for ja;
  HSK 1–6 for zh; `public/words/SOURCES.md`). Languages without a bundled
  list use the same FrequencyWords source (it covers ~60 languages).
- **Coverage**: for each chapter and book, the frequency band needed to know
  95% and 98% of the running words (98% is the usual threshold for reading
  without help; 95% is reading with a dictionary at hand, which is what the
  tap-a-word reader gives).

| Language                          | Level shown                   | From                                                                                                                                  |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| en, fr, de, es, it, pt, ru, ko, … | CEFR A2–C2                    | 95% coverage band: ≤1 000 lemmas ≈ A2, ≤2 000 ≈ B1, ≤4 000 ≈ B2, ≤8 000 ≈ C1, beyond ≈ C2; mean sentence length nudges it half a step |
| ja                                | JLPT N5–N1                    | share of words in each JLPT list, plus kanji outside the jōyō set; 文語 and 旧仮名 texts get a "classical" badge instead              |
| zh                                | HSK 1–6 (HSK 3.0 bands later) | share of words per HSK list, plus characters outside the 3 500 common ones; 文言文 gets a "classical" badge                           |

Levels are labelled estimates. **Personal fit** (phase 2): the same coverage
against the user's own cards gives "you know 91% of the words in this
chapter", which sorts the shelf for them.

**The starter shelf** is a list of references (source + id), not texts: kept
in D1 and editable by the owner, fetched on first open. Children's literature
and fairy tales first, so there is something at every level (Grimm,
Andersen, Perrault, Aesop; 宮沢賢治, 新美南吉, 小川未明; 鲁迅's short pieces,
唐诗), then the novels everyone knows (『坊っちゃん』, 芥川, Austen, Verne,
Dumas, Cervantes, Chekhov). Books users add with a public-domain verdict
join the shelf too.

## 5. Adding a book, and attribution everywhere

**Add from the UI** (`/books` → "Add a book", a glass sheet):

- **Paste a link** to a work on any source in section 1 (a PG ebook page, an
  Aozora card page, a Wikisource page, an archive.org item). The adapter
  resolves it; a link to an unknown host says which sources work.
- **Search**: one box, the study language preselected; results from the
  adapters' search, grouped by source, each with title, author, year, source
  and a verdict chip (public domain / open licence / unverified / in
  copyright). The same work from two sources is one result with the best
  edition first.
- **Before adding**, the sheet shows the attribution block: title, author
  (with dates), source and its link, edition (底本 for Aozora), licence, and
  the verdict with its reason. "Add" starts the pipeline; refused items have
  no Add button, only the reason.
- Added books appear in "My books"; shared ones also on the shelf for others.

**Attribution after adding.** Every place a book's text appears names its
source:

- The book's first page and its info sheet: the full attribution block, plus
  any credits the source asks for (Aozora 入力・校正, Wikisource editors' CC
  BY-SA notice, Standard Ebooks' CC0 note).
- **Every card made from a book stores its source.** Word cards in the Books
  list get `src` on their entry (a migration adding a `src` JSON column to
  `word_list_entries`); sentence and phrase cards get the same field on their
  note. `src` is `{bookId, title, author, source, licence, url, chapter,
sentence}`: enough to show it without the book and to jump back to the
  sentence.
- **The card shows it**: on /words a one-line source under the example
  ("夏目漱石『坊っちゃん』 · 青空文庫 · public domain"), tappable to open the
  book at that sentence; the same on a sentence card's back.
- Exports carry it: an Anki export (`lib/words/apkg.ts`) adds a Source field,
  and a CC BY-SA card keeps its licence line.

## 6. Reading on the phone

Follows [design-principles.md](design-principles.md): the text fills the
screen; the toolbar, the word sheet and hints are glass overlays.

**/books (the shelf).** Tabs: Shelf, My books. One row per book: title,
author, level chip, length in minutes, source, a progress ring for books
started. Filters as glass chips: language (the study language first), level,
length, source. "Continue" on top is the book node last read (section 7).

**/books/[id] (the reader).** Two modes, one tap apart:

- **Page mode.** Running text, the current sentence softly highlighted;
  words tinted by the user's state (all colours oklch): learning words
  underlined in the due colour, words with a card a faint dot. Furigana from
  ruby or the analyser's readings, togglable.
- **Sentence mode** (default on a phone, and for listening). One sentence,
  large, centred; the translation hidden until tapped. Swipe up = next, down =
  back, as on /words.

**Read-aloud.** Play reads sentence by sentence along the clip plan and
follows along. `lib/words/audio-cache.ts` prefetches the next clips as it
prefetches rows near the screen, keeps every clip on disk (Cache API), and
falls back to the browser's speech for languages the server cannot voice
(MeloTTS: en, es, fr, zh, ja, ko). Speed and voice are /words' preferences.

**Tap a word** → a glass sheet: the word, lemma, reading, gloss, level
(JLPT N3, HSK 4, top 2 000), whether it is in one of the user's lists; play
word, play sentence; **Add card** (one tap, to **Books · <language>**,
created on first use, the sentence as `ex`, its translation as `exTr`, and
`src`); if the word already belongs to a bundled list the user studies, the
sheet offers that list instead, so one word never has two cards. The gloss
comes from the book's glossary (offline), then `/api/translate` (online).

**Long-press a sentence** → sentence card (front: sentence; back:
translation, audio, source), saved like the AI sentence cards. Selecting
across words makes a phrase card. **"Re-read later"** adds the chapter URL as
an ordinary page card, so FSRS brings it back.

**LibriVox audio (phase 2).** Each chapter's MP3 is aligned to our sentences
(Whisper word timestamps, see [local-stt.md](local-stt.md)); the reader then
plays ranges of one human recording instead of TTS clips. A chapter that
aligns badly keeps TTS. The recording's reader is credited like a source.

## 7. Reading progress as tree nodes

The user's tree, not the dev one (that one is public and the owner's alone).
The calendar design already proposes a per-user tree (`plan_items`, shown as
`/plan` in the chat's Tree view by `StateTree.tsx`). Books should use **the
same generic table**: one tree per user with free-form `kind`s. Suggested
generalisation, to agree with the calendar work before either migrates:

```sql
CREATE TABLE user_nodes (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  parent_id  TEXT,
  path       TEXT NOT NULL,          -- /books/ja/botchan/ch-03
  kind       TEXT NOT NULL,          -- free-form: book | chapter | goal | habit | …
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,          -- open | doing | done | dropped
  pct        REAL,                   -- 0–100
  data       TEXT,                   -- JSON, per kind
  sort       REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE (user_id, path)
);
```

```
/books
  /books/ja                                kind lang
    /books/ja/botchan                      kind book     status doing  pct 34
      data {bookId, source, startedAt, lastReadAt, cardsAdded: 27}
      /books/ja/botchan/ch-01              kind chapter  status done
      /books/ja/botchan/ch-02              kind chapter  status doing  pct 60
        data {sentence: 41, of: 68, mode: "sentence", listened: true}
```

- Chapter nodes are created when a chapter is opened, so an unread book is
  one row.
- The book's `pct` is derived from its chapters.
- The cursor is written when the reader stops moving (like the scroll
  position in [ui-state.md](ui-state.md)), queued offline like word reviews,
  merged last-writer-wins per node ([sync-merge-rules.md](sync-merge-rules.md)).
- The Learning Partner and the calendar address it by path: a "reading" study
  block points at `/books/ja/botchan`.

## 8. Offline

- **The shelf and My books** (manifests only) are cached like the word-list
  catalogs (`lib/words/catalog-cache.ts`, IndexedDB, stale-while-revalidate).
- **Download a book**: its processed chapters, glossary and manifest (with
  attribution) go into IndexedDB (a `books` store in a new version of
  `lianki-words`). A chapter is ~20–80 KB; a novel 1–3 MB.
- **Audio**: a downloaded book's clips are fetched as low-priority `stock`
  into their own cache (`lianki-book-audio-v1`), so word clips and book clips
  do not evict each other. Never on Save-Data or 2G; the size is shown first.
- **Offline taps**: the glossary is local; Add card, sentence cards and
  progress go to the pending queue (`lib/words/pending.ts`).
- Adding a new book needs the network (the server fetches it).

## 9. What exists today to build on

| Today                                                               | Where                                                                                                                  | Reuse                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/read`: paste text, read it line by line with auto-advance and TTS | `app/(app)/read/*`, `app/api/read/*`, `lib/getReadMaterialsCollection.ts` (D1 + R2)                                    | The seed of the sentence player (it uses `/api/tts` and a fresh `Audio` per line, no cache). Later one shared reader: a pasted text becomes a private book with source "pasted by you". |
| /words lists, cards, reviews, offline queue, Anki export            | `app/(app)/words/*`, `lib/repos/wordsD1.ts`, `lib/repos/wordEntriesD1.ts`, `lib/words/idb.ts`, `pending.ts`, `apkg.ts` | The Books list is an ordinary list with entries (like an Anki import, `source` `book:`), plus the `src` column.                                                                         |
| Word audio, prefetch, disk cache, R2 clip cache                     | `app/api/words/tts`, `lib/words/audio-cache.ts`, `audio-disk.ts`, `lib/ttsCache.ts`, `lib/voice.ts`, `workers/voice`   | Sentence clips use the same queue, cache and keys.                                                                                                                                      |
| Frequency, JLPT and HSK lists; lemma folding                        | `public/words/*`, `scripts/words/build-word-lists.ts`, `filter-kaikki.ts`                                              | Grading and glossaries.                                                                                                                                                                 |
| Sentence cards                                                      | `app/api/ai-sentences/save-cards`, `app/api/polyglot/*`                                                                | Long-press sentence → the same shape, plus `src`.                                                                                                                                       |
| Page cards (FSRS by URL)                                            | `app/fsrs.ts`, `src/lianki.user.ts`                                                                                    | "Re-read later"; and web pages that are not books.                                                                                                                                      |
| Translation                                                         | `/api/translate`, [workers-ai.md](workers-ai.md)                                                                       | Online gloss and sentence translation.                                                                                                                                                  |
| Rate limiting, R2, Durable Objects                                  | `lib/rateLimit.ts`, `lib/d1`, `workers/push`                                                                           | Per-host fetch limiter, book storage.                                                                                                                                                   |
| Per-user tree                                                       | [calendar-plan.md](calendar-plan.md) `plan_items`, `StateTree.tsx`                                                     | One generic node table for `/plan` and `/books`.                                                                                                                                        |

## 10. MVP

In: adapters for **Project Gutenberg (mirror + catalogue), Standard Ebooks,
Aozora, Wikisource (all languages), Internet Archive (PD items), Kanseki
Repository**; the licence check with all five verdicts; the server pipeline
(fetch, R2 cache, preprocessing with ja/zh tokenizers, grading, glossary,
clip plan); add by link and by search; the starter shelf for ja, zh, en, fr,
es, de; the reader (sentence and page modes), read-aloud, tap → Add card,
sentence cards; `src` on every card and shown on it; progress nodes;
offline download; 16-locale strings.

Out (phase 2): the other adapters in section 1 (Runeberg, DTA, NDL, BNR,
Liber Liber, Ben-Yehuda, 공유마당, …; ~1–2 h each), LibriVox alignment,
personal coverage, pre-rendered clips, phrase cards, /read on the shared
reader.

| #   | Piece                                                                                                   | Agent hours |
| --- | ------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Adapter interface + PG, Standard Ebooks, Aozora, Wikisource, IA, Kanripo (search, resolve, fetch, meta) | 8           |
| 2   | Fetching: User-Agent and bot page, robots, per-host limiter (Durable Object), R2 cache, `books` table   | 4           |
| 3   | Licence check: facts from adapters + Wikidata, verdicts, reasons, owner's unknowns queue                | 4           |
| 4   | Preprocessing queue: clean, chapters, sentences, ja/zh tokenizer spike + integration, lemmas            | 7           |
| 5   | Grading, glossary, TTS clip plan                                                                        | 3           |
| 6   | Add a book: link + search sheet, attribution block, SSE progress, shelf / My books                      | 5           |
| 7   | Reader: sentence and page modes, word tints, furigana, glass toolbar                                    | 6           |
| 8   | Tap-a-word sheet, Add card, sentence cards; `src` migration, source line on cards, Anki export field    | 6           |
| 9   | Read-aloud through audio-cache, follow-along                                                            | 3           |
| 10  | `user_nodes` migration, repo, progress API, offline queue                                               | 4           |
| 11  | Download for offline                                                                                    | 3           |
| 12  | QA (unit + qa suite, adapter fixtures, no live fetches in tests), i18n, docs                            | 4           |
|     | **Total**                                                                                               | **≈ 57**    |

Lanes once the chapter JSON format is fixed: server (1–5), app (6–11), with
12 alongside. Wall clock about 20–24 agent hours.

**First slice to show you (≈ 20 agent hours):** PG, Standard Ebooks and
Aozora adapters; the fetch cache and licence check; preprocessing for ja
(analyser) and en; add by link and search; sentence mode, read-aloud, tap →
Add card with `src` shown on the card; progress cursor. No offline download,
no page mode. Previewed on your phone over the tailnet before production.

## 11. Risks

- **Hard texts.** The children's shelf and the coverage sort carry the low
  levels; a "too hard" badge rather than hiding it.
- **Licence mistakes.** Facts with sources for every verdict, refusals in
  words, private-only for unknowns, a takedown address on the bot page, and
  one row to remove a book everywhere.
- **Being a bad citizen to small archives.** One fetch per work, per-host
  limits, robots, no bulk, a contact page; adapters for sites that ask for
  no automation stay search-only.
- **Worker limits for ja/zh dictionaries.** Spiked first; container fallback.
- **TTS cost.** Shared books' clips are generated once and kept in R2; private
  books' misses stay rate limited per user.
- **OCR and old orthography** (IA, NDL, 旧仮名, 文言文): quality score and
  badges.

## 12. Questions for you

1. Cards from books: one Books · <language> list (my proposal), or straight
   into the JLPT/HSK/frequency list the word belongs to?
2. Progress in your per-user tree (`/books/...` next to `/plan`): is that the
   "state tree" you meant, and should `plan_items` become the generic
   `user_nodes` table?
3. Non-commercial sources (Gallica, CBETA, HathiTrust Google scans, CText):
   skip them (my default), or allow them for free users only?
4. "Licence unverified" books: allow them as private books after the user
   confirms (my proposal), or refuse them too?
5. First slice: ja + en, or zh first?
6. After the MVP: human audio (LibriVox) or more adapters first?
