# Books: a public-domain library you can actually read (plan)

Owner's vision, 2026-11-03 15:15–16:33 JST. Design only; nothing here is
built yet except EPUB import on /read (#448) and a book's word count and
progress (below).

## Why

Public-domain books are humanity's shared library. Book sites only offer the
reading itself, which is unfriendly to anyone not fluent in the text's
language. Lianki can close that gap: split each book into its **words,
phrases and concepts** and let the reader review them on their own, so the
book becomes readable step by step.

This is a **general system for every user**. The owner's own goal (reading
_Le Petit Prince_ in French) is a test case, never a product default.

## The flow

1. Open **阅读 /read**, pick a book: from the shared catalogue, or your own
   copy (EPUB import, #448; paste; later URL/photo).
2. Set it as a **goal** (optionally with a target date).
3. Read it **progressively**: chunks of about 250 words (Latin scripts) or
   600 characters (CJK), 2–3 minutes each, never cutting a sentence.
4. Each chunk you finish is **split automatically** into words, phrases and
   concepts you don't know yet (deduped against your existing cards), which
   go into a per-book word list and follow the usual review-first scheduling.
5. Progress shows on the roadmap: **% read** and **% of the book's running
   words you have mastered**. "看懂" = all read and coverage ≥ 98% (Hu &
   Nation 2000, the threshold for reading without a dictionary).

## Built: a book's words and progress (2026-11-03)

Owner, 17:01–17:18 JST: show the word count besides the line count, and his
progress counted in words, as if the book were a deck; at import, how many
words were found and how many are learned, new and unrecognised; the pass
mark is 95% (the research's measure, "我们用同样口径统计"), it earns the
book a ✓, and the day it first passed is kept.

- **Counting** (`lib/read/words.ts`, once at import, stored as `words` in the
  book's meta in `read_materials.content`; books imported before it are
  counted on first read and saved back, so nothing needs re-importing).
  Words are `Intl.Segmenter` word segments in the book's language (EPUB
  metadata, or guessed for pasted text), NFKC, lowercased, French/Italian
  elisions and English `'s` stripped.
- **Coverage, the ring and the pass:** (running words mastered + running
  words that are names) ÷ running words. Left out entirely: numbers,
  punctuation, single letters (not CJK characters), web addresses and other
  junk. Names count as known, as Hu & Nation (2000) did: a word never written
  in lower case and capitalised mid-sentence at least once (not in headings
  or capitals; none for German or caseless scripts). **Mastered** is a
  /words deck's: a card, in any of the reader's lists in that language,
  whose interval is a year or more (or the list's shorter cap). Unrecognised
  words stay in the denominator as unknown. Passes at **95%**; the first
  pass is stored in `read_materials.passed_at` and never overwritten (the ✓
  fades with its date if coverage drops again). Decks do not record a pass
  time yet; they could reuse the same idea.
- **Scan summary** (reader's header, distinct words): mastered, learning (a
  card, not mastered), new (no card, but in one of our word lists or the
  reader's imported decks), unrecognised (in none; the list opens on tap),
  plus names. Which public lists hold a word is decided on the device from
  the catalogs it caches for /words.
- **Approximation:** surface forms, with cheap folds (plural -s/-es/-x,
  -ed, -ing, French -e) tried only when the folded form is itself a card or
  entry. Japanese and Chinese depend on the segmenter's dictionary. Real
  lemmas come with the extraction step below.
- One card query per request, scoped to the signed-in user; no polling.

## Sources and copyright

- **Shared catalogue:** only works public domain in the US (published in or
  before 1930 as of 2026; the cutoff moves each 1 January) **and** with every
  creator, translators included, dead 80+ years. Candidate sources: Project
  Gutenberg, Standard Ebooks, Wikisource, Aozora Bunko (check US status per
  work), zh.wikisource. Text and its extraction are shared and paid for once.
- **Your own copy:** private to you, never shared or listed, deletable,
  DRM-free only (#448 refuses DRM). Needs a ToS line and a takedown contact
  before it opens beyond the owner.
- _Le Petit Prince_: protected in the US until 2039 and in France until about
  2032, so it can never be in the shared catalogue; own copy only. Its
  drawings and name are trademarks.

## A first multilingual text: the Bible, in its original languages

The owner's example (16:34 JST), refined at 16:36: chosen for language-learning
value, not to promote a religion (present it neutrally, alongside other
classics). Use the **original-language texts** (Hebrew, Aramaic, Greek) to stay
out of translation-edition disputes; English only as a gloss. Leads to verify
(the digital edition's licence, not just the text's age):

- **Hebrew Bible:** the Westminster Leningrad Codex text (public domain) via
  the Open Scriptures Hebrew Bible (OSHB; its lemma and morphology data are
  CC BY 4.0, a good fit for word splitting).
- **Greek New Testament:** SBLGNT (check its current licence: it moved to
  CC BY 4.0), the Robinson–Pierpont Byzantine text (public domain), the
  Textus Receptus (public domain). **Nestle–Aland / UBS are copyrighted:
  never.**
- **Greek Old Testament (Septuagint):** Swete's edition (public domain).
  Rahlfs (1935) is copyrighted by the Deutsche Bibelgesellschaft: never.
- **English gloss:** the World English Bible (explicitly public domain), not
  KJV (Crown letters patent in the UK) and no modern copyrighted version.
- Segmenting: Hebrew needs prefix/suffix splitting (OSHB morphology covers
  it); Greek is inflected, so cards carry the lemma plus the form read.

## Classical languages: Buddhist sutras and more

The owner (16:35 JST): Sanskrit Buddhist sutras too, and other classical
texts, if licence-safe sources exist. Leads to verify before use (the
digital edition's licence matters, not only the age of the text):

- **Pali canon:** SuttaCentral publishes the Pali (Mahāsaṅgīti) text and
  Bhikkhu Sujato's English translations under CC0. Strong first candidate.
- **Chinese canon (大正藏):** the printed edition (1924–1934) is old, but
  the usual digital text, CBETA, is **CC BY-NC-SA: non-commercial**, so it
  cannot be used in Lianki as is. Needs another source or permission.
- **Sanskrit:** GRETIL and the Digital Sanskrit Buddhist Canon have mixed or
  unclear terms per text; check each file's header. Use only texts with an
  explicit free licence.
- Other classical languages (Latin, Ancient Greek, Classical Chinese,
  Classical Japanese) mostly via Perseus (CC BY-SA), Wikisource and ctext
  (check its terms).

Segmenting these needs care (Sanskrit sandhi, Pali compounds, classical
Chinese without spaces); a later phase, after modern languages.

## Same book, many uploaders: store it once

The owner (Slack, 2026-11-03 ~17:20 JST): several users may import the same
EPUB, so keep one copy. Content-addressed storage: the book text, its chunks
and its extraction are stored once under a hash of the normalised content and
paid for once. Each user has only their own row ("I imported this"), sees the
book only if they uploaded it, and deleting removes just that row; the text
goes when the last row does. Progress and scan stats stay per user. No
"instant upload" shortcut: every upload runs the full upload and check, and
the dedupe happens server-side only, so nobody can learn that someone else
has the same book.

## Cost

Extraction with Workers AI (gpt-oss-120b) is about $0.002 per chunk: about
$0.12 for _Le Petit Prince_, about $0.8 for a long novel.

## Phases (agent hours)

- **0 (2):** rights rule + checker; seed script for one catalogue language.
- **1 (≈14):** chunking, chunk reading on /read with 「读完」 and a cursor,
  extraction + dedupe into a per-book list, roadmap goal with both bars.
  One book, one language, owner only, behind a flag.
- **2 (≈10):** chat import, URL/photo import, tap-a-word glosses, partner
  schedules chunks per day toward the target date.
- **3 (≈10):** catalogue in many languages, per-country gating, better
  segmenters (Sudachi, jieba), the generic node tree from calendar-plan.md.

## Decisions so far

- Pass mark for a book = the word decks' pass mark: 60% of its words with an
  interval over one year (owner, Slack ~17:05 JST). The 98% coverage figure
  (Hu & Nation 2000) is secondary.
- His own French EPUB of _Le Petit Prince_ is the first test book (imported
  via #448).

## Open decisions (owner)

1. Book/language for v1 (his French EPUB is already imported).
2. The shared-catalogue rule as above, or stricter (death 100+ years).
3. Free monthly quota for own uploads; credits beyond it? **Decided
   2026-11-03 (Slack): by how much they have topped up** — upload and
   extraction allowance scales with the user's credit top-ups (the wallet).
4. v1 owner-only behind a flag? **Decided 2026-11-03 (Slack): yes.**
5. Accept the own-upload legal risk (ToS + takedown contact)? **Decided
   2026-11-03 (Slack): yes — a user's own upload is fine as long as it is
   never shared** (private, unlisted, deletable).

## The reader: one continuous scroll (design, 2026-11-03)

Owner, 18:30 JST: "阅读模式也希望是一个无限滚动的 UI … 完整地再思考一下这个功能的整体 UX".
He wants to scroll with his finger staying in one place, and rejected tall,
sparse layouts (words-session-spec.md), so the reader is a dense book page,
not a list of rows. Also: show his familiarity on every word, virtualise for
performance (18:32), and keep visual nesting to one level (design-principles).

- **Scroll and render.** The window scrolls (no inner box), so browser bars
  collapse and the bottom island's scroll-shrink works. Paragraphs are
  virtualised (`@tanstack/react-virtual`, `useWindowVirtualizer`, measured
  heights, ~6 overscan): a 60-chunk book keeps ~30 nodes mounted. Each
  paragraph is a memoised `<p lang>` rendering its word spans in one pass;
  one delegated tap listener; passive rAF-throttled scroll handler. Book text
  cached in IndexedDB for offline. No section paging, line numbers, row
  borders or inner scroller.
- **Chapters.** Sticky chapter title under the top strip; TOC sheet behind
  the ring; a thin right-edge scrubber with chunk ticks, read shading and
  today's marker.
- **Position.** Stored as an anchor (line, offsetRatio), never pixels, and
  synced: D1 `read_progress(email, material_id, line, offset, read_through,
  updated_at)`, written 1.5 s after scrolling stops and on `pagehide`; newest
  anchor wins, `read_through` only grows. localStorage stays as cache.
- **Familiarity on every word.** From the per-book word map
  (`/api/read/[id]/words`, fetched once, memoised): unrecognised dotted
  underline, new faint underline, learning light tint, mastered and names
  unmarked; levels off / unknown only (default) / all. Tap → glass half-sheet
  (word, reading, 🔊, gloss — catalogue first, else a cached in-context
  Workers AI gloss — sentence, add to book list, known). Long press → native
  selection + pill (translate, add phrase, read from here). The coverage ring
  sits small in the top strip; its sheet holds TOC, per-chapter coverage and
  the scan summary.
- **Playback.** Keep the tested reducer (`lib/read/player.ts`); highlight by
  sentence (`speechChunks`), no per-word highlight. Follow keeps the current
  paragraph at ~35% height; any drag stops following and shows "↧ back to the
  line". Wait cue inline: an amber rail and "轮到你 🎤 · 下一句 ›" at the
  paragraph's end. Shadowing fills a bar; mic hold and auto-advance stay.
- **Progressive reading.** Chunks are whole paragraphs (~250 words / 600 CJK
  chars) stored in `BookMeta` at import. A chunk is read when all of it has
  passed the reading zone with ≥ 40% of its expected time spent, or it was
  played/shadowed. Today's portion ends at a soft divider ("今日 3/3 ✓ · 继续读"),
  never blocking. Read chunks queue extraction (once per content hash) into
  the book's list.
- **Chrome.** Glass top strip (back, chapter, ring; hides on scroll down), a
  play pill at the right thumb (play/pause, auto, Aa), bottom island hidden on
  `/read/[id]` (pending owner) which also ends the overlap bug. Aa sheet: a
  new `read` text-size area (#436), line spacing, serif/sans, mark level.
- **Options.** A, book page (recommended): free scroll + floating pill. B,
  teleprompter: current paragraph pinned to a reading line, the island
  becomes the player — later as a 跟读 mode inside A.
- **Phases (agent hours).** 1 (6): virtualised scroll, chapters, TOC,
  scrubber, synced position, chrome, island fix. 2 (4): follow, sentence
  highlight, inline wait cue, pill, shadowing fill. 3 (6): marks, gloss sheet,
  selection pill, ring, per-chapter coverage. 4 (5): chunks, read tracking,
  today divider, 读完, extraction trigger.
- **Open decisions (owner, Slack 2026-11-03):** A or B; hide the island in
  the reader; does "known" count as mastered toward 95%; auto-jump to the
  newest position across devices; default 3 chunks a day.

### Combo-click expanding selection (owner, 2026-11-03 18:38 JST)

"连点扩选": each extra click in a combo selects the next larger unit — not a
fixed count, the rule is "one level up per click" — up to the whole book:
word → phrase (only if the word sits in a known phrase) → sentence →
paragraph → chapter → book. Where the text is too large to select for real
(a chapter or the book in a virtualised list), it is a **virtual selection**:
the range is held as data and shown as a card pointing at the unit, without
selecting DOM text.

- **Combo timing.** Clicks within the platform double-click interval (≈ 350
  ms, from `pointerdown` timestamps; one delegated listener on the scroller)
  extend the level; a pause ends the combo, and a click outside clears it.
  Native double/triple-click selection is suppressed in the reader so the
  levels stay ours.
- **The card.** Every level shows one glass card for the selected unit (one
  layer, per the no-nesting rule): the unit's kind and text preview (or
  title and size for chapter/book), its familiarity summary, actions that fit
  the unit (gloss / add / translate / read from here / copy text), and a
  🔗 **link button drawn as our own inline SVG** (stroke `currentColor`,
  colours oklch; never an emoji). Tapping it copies the unit's link.
- **Addressable units (deep links).** Stable IDs that survive re-imports of
  the same content (derived from the content-hash book id of the dedupe plan
  and positions in `lines`):
  `/read/<book>` · `#ch=<n>` · `#p=<line>` · `#s=<line>.<sentence>` ·
  `#w=<line>.<token>` · `#ph=<line>.<startToken>-<endToken>`. Opening a link
  scrolls the virtualised list to the anchor, flashes the unit and shows its
  card. Links open only for someone who has access to that book (own upload
  or catalogue); for a private book they are personal bookmarks.
- **Phrases.** Phrase boundaries come from the extraction step (books-plan
  phase 1); until then the phrase level is skipped.

### Show the book as it is (owner, 2026-11-03 ~18:52 JST)

"在 UI 上，图书导入进来段落长什么样，我们也显示成什么样". The reader shows the
book's own structure, not ours: one block per paragraph of the source, the
book's headings as headings, line breaks inside a paragraph (verse, letters,
dialogue lines) kept, and inline emphasis (italics, bold, small caps)
preserved. Nothing re-wrapped into our own units. The EPUB import (#448)
today keeps paragraphs and headings but drops inline emphasis and in-paragraph
line breaks; the reader rebuild should store and render them (a small inline
markup per line, sanitised — never raw HTML from the book).
