# Books — public-domain classics to read, hear and mine for cards

Status: **concept only, nothing built** (2026-10-31). Owner request, voice,
2026-10-30 23:49–23:50 JST: preload learning content, namely public-domain
books (classics) in each language, linked to /words (tap a word to add a
card). UX first.

> 中文摘要：每种语言预置一批公版书（日语青空文库、中文维基文库、英法德西等用古腾堡 /
> Standard Ebooks），按难度分级（与现有词表比对的词频覆盖率 → JLPT / HSK / CEFR 估计）。
> 手机上全屏阅读，一句一句朗读（复用 /words 的 TTS 和本机音频缓存），点词看释义、一键加卡到
> /words，长按句子做句子卡。阅读进度存成每个用户自己的树节点（一本书 = 一个子树），可整本下载离线读。
> MVP 约 39 个 agent 小时（并行约 15–18 小时）；先做日语 + 英语的一小片约 12 个 agent 小时。

**What I understood, to be corrected.** The request came by voice, so these
are my readings of it; section 10 lists the questions.

1. "Preload" = Lianki ships a curated shelf of books per language, ready to
   open; nobody has to paste or import text. A book can also be downloaded to
   the device for offline reading.
2. "Linked to /words" = a tapped word becomes a card in a /words list, with
   the book's sentence as its example.
3. "State tree" = the user's own tree of generic nodes (as the calendar plan
   proposes for `/plan`), not the public dev tree in `docs/state-tree.md`.

## 1. Sources and licences

Rule for the shelf: **a text goes in only if it is public domain in the US
(where the main archives and our CDN edge are judged) and in the author's
country, and the author died 70+ years ago** (in 2026: died in 1955 or
earlier). Translations count as new works, so the shelf carries **original
texts in their own language**, never a recent translation. Every book carries
`source`, `license`, `author_died`, `published` and the source URL in its
manifest, as each `public/words/*.json` file already does.

| Source                                                           | Languages                                       | Licence of the text                                                                                                      | Terms that matter to us                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Project Gutenberg](https://www.gutenberg.org)                   | en (most), fr, de, es, fi, nl, it, pt, zh (few) | Public domain in the US; the "Project Gutenberg" name is a trademark                                                     | Redistributing **with** the PG header and name means following its licence (and a royalty on commercial use of the trademark). Stripping the header, footer and every mention of PG leaves a plain public-domain text, which is what we ship, with a "source: Project Gutenberg ebook #N" credit line in our own words. PG forbids crawling its site: bulk access goes through its **rsync mirrors or the `gutenberg.org/cache/epub/feeds` catalog** (RDF/CSV), at a modest rate. PG judges by US law only; we apply the life+70 check on top. |
| [Standard Ebooks](https://standardebooks.org)                    | en                                              | Texts US public domain; their typography and markup dedicated **CC0**                                                    | The cleanest English source: proofread, modern spelling, semantic EPUB. Each book's source is a public GitHub repo (`standardebooks/*`), which we clone. Their bulk feeds are for patrons; per-book downloads are free. Prefer it over PG for English when both have a book.                                                                                                                                                                                                                                                                   |
| [青空文庫 Aozora Bunko](https://www.aozora.gr.jp)                | ja                                              | Most works: copyright expired; some (`作品著作権フラグ` = あり) are in copyright and posted with the author's permission | Use only works whose copyright flag is なし. Aozora asks nothing for public-domain texts (commercial use included); keep the 底本 and 入力・校正 credits, which is customary. Bulk access: the GitHub mirror `aozorabunko/aozorabunko` plus the index `list_person_all_extended_utf8.csv`. Prefer **新字新仮名** editions for learners; 旧字旧仮名 works are flagged as hard. Aozora's ruby (`《》`) gives us furigana for free.                                                                                                               |
| [Wikisource](https://wikisource.org) (zh, ja, fr, de, ru, es, …) | many                                            | The works are public domain; transcriptions, annotations and translations by editors are **CC BY-SA 4.0**                | zh.wikisource is the main Chinese source (classics, 鲁迅, 胡适, …); fr.wikisource is large. Pages are fetched through the MediaWiki API (or ws-export EPUBs) with a User-Agent and rate limit. Ship only original texts; anything editor-added keeps CC BY-SA attribution.                                                                                                                                                                                                                                                                     |
| [LibriVox](https://librivox.org)                                 | en (most), de, fr, es, nl, zh, ja, …            | Recordings dedicated to the **public domain**; the texts read are US public domain                                       | Free human audio, MP3s hosted on archive.org. Quality and speed vary by reader. Phase 2: align recordings to sentences (section 4).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Others to avoid or check                                         | —                                               | —                                                                                                                        | Projekt Gutenberg-DE (spiegel.de) and lib.ru are **not** free to copy. Korean: 공유마당 (gongu.copyright.or.kr) lists public-domain works with a clear licence. Spanish: Biblioteca Virtual Miguel de Cervantes has its own terms; take the PG or Wikisource copy instead.                                                                                                                                                                                                                                                                     |

**Copyright terms by country** (what the life+70 check is for):

| Where                  | Term                                                                                                  | Pitfall                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US                     | Works published before 1931 are public domain (in 2026); later ones depend on publication and renewal | Foreign works had copyright restored in 1996 (URAA) if still protected at home then                                                                                                                           |
| EU, UK, Russia, Korea  | Life + 70                                                                                             | France adds wartime extensions: up to +30 years for authors "mort pour la France" (Saint-Exupéry is free in most of the EU but not in France until 2032). Russia adds 4 years for WWII participants.          |
| Japan                  | Life + 70 since 2018-12-30                                                                            | Not retroactive: an author who died in 1967 or earlier was already free under life + 50 and stays free; those who died from 1968 on wait 70 years. 太宰治 (d. 1948), 夏目漱石, 芥川龍之介, 宮沢賢治 are free. |
| Mainland China, Taiwan | Life + 50                                                                                             | 鲁迅 (d. 1936) is free everywhere; a writer who died in 1970 is free in China but not under life + 70.                                                                                                        |
| Canada                 | Life + 70 since 2022-12-30, not retroactive                                                           | —                                                                                                                                                                                                             |
| Mexico                 | Life + 100                                                                                            | We do not geo-block; the intersection rule above covers almost every case, and a takedown address is in the manifest.                                                                                         |

The licence check is a script (`scripts/books/check-licence.ts`): it refuses a
manifest without a death year, a death year after 1955, a US publication year
after 1930 without an exemption note, or an Aozora flag of あり. It runs in the
pre-commit hook like the secret scan.

## 2. Difficulty grading

The problem with classics: most are B2+ for a learner. Grading is what makes
the shelf usable, and it also decides what goes on it.

**Per-language pipeline (build time, `scripts/books/build-books.ts`):**

1. Split into chapters (the source's own headings) and sentences
   (`Intl.Segmenter` with `granularity: "sentence"`; Japanese 「」 dialogue
   kept whole).
2. Tokenize words: `Intl.Segmenter` `"word"` (ICU dictionaries handle ja and
   zh). Fold inflected forms to lemmas with the form → lemma maps the word-list
   build already makes from the kaikki Wiktionary extracts.
3. Rank every lemma against the frequency ranks the bundled lists come from
   (hermitdave/FrequencyWords for de/en/es/fr/it/ko/pt/ru; JLPT N5–N1 for ja;
   HSK 1–6 for zh; see `public/words/SOURCES.md`).
4. **Coverage**: for each chapter and book, the frequency band needed to know
   95% and 98% of the running words (98% is the usual threshold for reading
   without help; 95% is reading with a dictionary at hand, which is what the
   tap-a-word reader gives).

**Mapping to a level** (estimates, shown as such):

| Language                       | Level shown                   | From                                                                                                                                    |
| ------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| en, fr, de, es, it, pt, ru, ko | CEFR A2–C2                    | 95% coverage band: ≤1 000 lemmas ≈ A2, ≤2 000 ≈ B1, ≤4 000 ≈ B2, ≤8 000 ≈ C1, beyond ≈ C2; mean sentence length nudges it half a step   |
| ja                             | JLPT N5–N1                    | the share of words in each JLPT list, plus kanji outside the jōyō set; 文語 and 旧仮名 texts get a "classical" badge instead of a level |
| zh                             | HSK 1–6 (HSK 3.0 bands later) | the share of words per HSK list, plus characters outside the 3 500 common ones; 文言文 gets a "classical" badge                         |

**Personal fit, on the device:** the same coverage computed against the
user's own cards (words in any /words list they marked known or have learned)
gives "you know 91% of the words in this chapter", which sorts the shelf for
them. Phase 2.

**What goes on the first shelf**, so there is something at every level: fairy
tales and children's literature first (Grimm, Andersen, Perrault, Aesop;
宮沢賢治, 新美南吉, 小川未明 and the 赤い鳥 stories; 鲁迅's 故事新编 and
short pieces, 唐诗 as a short-text shelf), then the novels everyone knows
(夏目漱石『坊っちゃん』, 芥川, Austen, Verne, Dumas, Cervantes, Chekhov
stories). About 10–20 books per language.

## 3. Reading on the phone

Follows [design-principles.md](design-principles.md): the text fills the
screen; the toolbar, the word sheet and hints are glass overlays.

**/books (the shelf).** One row per book: title, author, level chip, length
in minutes, a progress ring for books started. Filters as glass chips:
language (the study language first), level, length. "Continue" on top is the
book node last read (section 5).

**/books/[id] (the reader).** Two modes, one tap apart:

- **Page mode.** Running text, sentences laid out as a book. The current
  sentence has a soft highlight. Words are tinted by the user's state
  (all colours oklch): learning words underlined in the due colour, words with
  a card already a faint dot, everything else plain. Furigana from Aozora ruby,
  togglable.
- **Sentence mode** (the default on a phone, and for listening). One sentence,
  large, centred; the translation hidden until tapped. Swipe up = next
  sentence, down = back, as the swipe card does on /words.

**Read-aloud.** Play reads sentence by sentence and follows along; the
highlight moves, the text scrolls under the glass. Speed and voice are the
same preferences /words uses. Each sentence is one clip from
`/api/words/tts` (≤ 200 characters; a longer sentence is split at a comma).
`lib/words/audio-cache.ts` prefetches the next sentences the same way it
prefetches rows near the screen, keeps every clip on disk (Cache API), and
falls back to the browser's speech for languages the server cannot voice
(MeloTTS covers en, es, fr, zh, ja, ko). Shelf books can have their clips
pre-rendered with the open voices (`lib/voice.ts`, `scripts/voice`) and served
by `workers/voice` at the edge for free, as word-list clips are.

**Tap a word** → a glass sheet from the bottom:

- the word as written, its lemma and reading, a short gloss, its level
  (JLPT N3, HSK 4, top 2 000) and whether it is in one of the user's lists;
- play the word, play the sentence;
- **Add card**: one tap. The card goes to the user's **Books · <language>**
  list (created on first use, source `book:`), with the book's sentence as
  `ex` and its translation as `exTr`, so the card on /words shows where it was
  met. If the word is already in a bundled list the user studies (say
  `ja-jlpt-n3`), the sheet offers that list instead, so one word never has two
  cards;
- a link "Open in /words" to the list.

The gloss comes, in order, from: the book's own glossary (built at build time
from the kaikki extracts and the JLPT/HSK lists, shipped with the book, so it
works offline); then `/api/translate` (Workers AI, online only).

**Long-press a sentence** → **sentence card**: the sentence on the front, its
translation and audio on the back, saved like the AI sentence cards
(`/api/ai-sentences/save-cards`). Selecting a phrase across words makes a
phrase card.

**Chapter as a page card.** "Re-read later" adds the chapter's URL as an
ordinary Lianki page card (the FSRS notes the userscript uses), so FSRS brings
the chapter back for a second, faster reading.

## 4. Audio from LibriVox (phase 2)

LibriVox recordings are human, free and usually better than TTS for a
classic. To follow along sentence by sentence, each chapter's MP3 is aligned
to our sentences at build time: Whisper word timestamps, matched to the text
(the local STT setup in [local-stt.md](local-stt.md) can run it). The book's
manifest then holds `{sentence → [start, end]}` and the reader plays ranges of
one file instead of TTS clips. Not every text matches its recording edition;
a chapter whose alignment score is low keeps TTS.

## 5. Reading progress as tree nodes

The user's tree, not the dev one: the dev state tree is public and the
owner's alone. The calendar design already proposes a per-user tree
(`plan_items`, shown as `/plan` in the chat's Tree view, rendered by
`StateTree.tsx` with the same node shape). Books should use **the same
generic table**, so it is one tree per user with free-form `kind`s rather than
a table per feature. Suggested generalisation (coordinate with the calendar
work before either migrates):

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

A book is a subtree:

```
/books
  /books/ja                                kind lang
    /books/ja/botchan                      kind book     status doing  pct 34
      data {bookId, edition, startedAt, lastReadAt, cardsAdded: 27}
      /books/ja/botchan/ch-01              kind chapter  status done
      /books/ja/botchan/ch-02              kind chapter  status doing  pct 60
        data {sentence: 41, of: 68, mode: "sentence", listened: true}
```

- Chapter nodes are created when a chapter is opened, not for the whole book,
  so a 40-chapter book is a few rows until it is read.
- The book's `pct` is derived from its chapters (sentences read / total).
- The cursor is written when the reader stops moving (like the scroll
  position in [ui-state.md](ui-state.md)), queued offline like word reviews,
  and merged last-writer-wins per node ([sync-merge-rules.md](sync-merge-rules.md)).
- The Learning Partner and the calendar address it by path: a "reading" study
  block points at `/books/ja/botchan`; "continue 坊っちゃん" opens the cursor.

## 6. Offline

- **The shelf** (book manifests: title, level, size) is a small JSON cached
  like the word-list catalogs (`lib/words/catalog-cache.ts`, IndexedDB,
  stale-while-revalidate).
- **Download a book**: its chapters (sentences, tokens, furigana), its
  glossary and its manifest go into IndexedDB (a `books` store in a new
  version of `lianki-words`). A chapter is ~20–80 KB of JSON; a novel, 1–3 MB.
- **Audio**: the clips of a downloaded book are fetched as low-priority
  `stock` (audio-cache.ts) into their own cache (`lianki-book-audio-v1`), so
  word-list clips and book clips do not evict each other; removing the book
  removes its clips. Never on Save-Data or 2G; the download shows its size first.
- **Taps offline**: the glossary is local, so meanings work; Add card and
  sentence cards go to the pending queue (`lib/words/pending.ts`) and send
  when back online; progress writes queue the same way.
- Online, books are static files: chapter JSON in R2 behind a public,
  edge-cached Worker route, the same pattern as `workers/voice`. Nothing
  touches D1 except progress and cards.

## 7. What exists today to build on

| Today                                                               | Where                                                                                                       | Reuse                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/read`: paste text, read it line by line with auto-advance and TTS | `app/(app)/read/*`, `app/api/read/*`, `lib/getReadMaterialsCollection.ts` (D1 + R2)                         | The line player is the seed of the sentence player. It uses `/api/tts` (OpenAI voices) and a fresh `Audio` per line with no cache. The book reader should replace it with one shared reader component; a pasted text then becomes a private "book" with the same tap-a-word and progress. |
| /words lists, cards, reviews, offline queue                         | `app/(app)/words/*`, `lib/repos/wordsD1.ts`, `lib/repos/wordEntriesD1.ts`, `lib/words/idb.ts`, `pending.ts` | The Books list is an ordinary list with entries (like an Anki import, `source` `book:`); cards and reviews need no change.                                                                                                                                                                |
| Word audio, prefetch and disk cache                                 | `app/api/words/tts`, `lib/words/audio-cache.ts`, `audio-disk.ts`, `lib/voice.ts`, `workers/voice`           | Sentence clips use the same queue, priorities and cache.                                                                                                                                                                                                                                  |
| Frequency, JLPT and HSK lists; lemma folding                        | `public/words/*`, `scripts/words/build-word-lists.ts`, `filter-kaikki.ts`                                   | Grading and glossaries reuse the ranks and the kaikki extracts.                                                                                                                                                                                                                           |
| Sentence cards                                                      | `app/api/ai-sentences/save-cards`, `app/api/polyglot/*`                                                     | Long-press sentence → the same card shape.                                                                                                                                                                                                                                                |
| Page cards (FSRS by URL, userscript)                                | `app/fsrs.ts`, `src/lianki.user.ts`                                                                         | "Re-read later" on a chapter URL.                                                                                                                                                                                                                                                         |
| Translation                                                         | `/api/translate`, [workers-ai.md](workers-ai.md)                                                            | Online gloss and sentence translation fallback.                                                                                                                                                                                                                                           |
| Per-user tree                                                       | [calendar-plan.md](calendar-plan.md) `plan_items`, `StateTree.tsx`                                          | One generic node table for `/plan` and `/books`.                                                                                                                                                                                                                                          |

## 8. MVP

In: the shelf for **ja, zh, en, fr, es, de** (10–20 books each), graded; the
reader with sentence mode and page mode; read-aloud with TTS and prefetch;
tap a word → gloss → Add card to Books · <lang>; long-press → sentence card;
progress nodes; download a book for offline; 16-locale UI strings.

Out (phase 2): LibriVox alignment, personal coverage score, pre-rendered open
voice clips for the shelf, phrase cards, replacing /read with the shared
reader, more languages (it, pt, ru, ko).

| #   | Piece                                                                                                                                      | Agent hours |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1   | Book build pipeline: fetch from the sources, strip PG headers, parse Aozora ruby, chapters, sentences, tokens, lemmas, glossary, R2 upload | 7           |
| 2   | Licence manifest and check script in the pre-commit hook                                                                                   | 2           |
| 3   | Grading (coverage → CEFR / JLPT / HSK) and picking the first shelf                                                                         | 3           |
| 4   | `/books` shelf page, filters, Continue                                                                                                     | 3           |
| 5   | Reader: page and sentence modes, word tints, furigana, glass toolbar                                                                       | 6           |
| 6   | Tap-a-word sheet, Add card (Books list), sentence card                                                                                     | 4           |
| 7   | Read-aloud: sentence clips through audio-cache, follow-along                                                                               | 3           |
| 8   | `user_nodes` migration, repo, progress API, offline queue                                                                                  | 4           |
| 9   | Download for offline (IndexedDB books store, book audio cache)                                                                             | 3           |
| 10  | QA (unit + qa suite), i18n strings, docs                                                                                                   | 4           |
|     | **Total**                                                                                                                                  | **≈ 39**    |

Pieces 1–3 (content) and 4–9 (app) run in parallel lanes once the chapter
JSON format is fixed, so wall clock is about 15–18 agent hours.

**First slice to show you (≈ 12 agent hours):** ja (Aozora: 宮沢賢治,
新美南吉, 夏目漱石『坊っちゃん』) and en (Standard Ebooks: Grimm, Aesop,
Austen), sentence mode, read-aloud, tap → Add card, progress cursor; no offline
download, no page mode. Previewed on your phone over the tailnet before it
goes to production.

## 9. Risks

- **Hard texts.** Even graded, classics are old language. The children's
  shelf and the 95%-coverage sort carry the beginner levels; a "too hard"
  badge is honest rather than hidden.
- **Licence mistakes.** The check script, original texts only, and a
  takedown contact in every manifest.
- **TTS cost.** Shelf books are fixed text: their clips are generated once
  (or pre-rendered) and cached forever, like word-list clips. Misses stay rate
  limited.
- **Old orthography and tokenisation** (旧仮名, 文言文, archaic spelling): badges,
  and a per-language token check in the build's unit tests.

## 10. Questions for you

1. Did you mean a shelf Lianki ships (my reading), or books the user picks
   from these sources and imports?
2. Cards from books: one Books · <lang> list (my proposal), or straight into
   the JLPT/HSK/frequency list the word belongs to?
3. Progress in your per-user tree (`/books/...` next to `/plan`): is that the
   "state tree" you meant, and should `plan_items` become the generic
   `user_nodes` table?
4. First languages: ja + en for the first slice, or zh first?
5. Is human audio (LibriVox) more important than offline? It decides what
   phase 2 starts with.
