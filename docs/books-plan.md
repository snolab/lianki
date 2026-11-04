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
  entry. Japanese and Chinese depend on the segmenter's dictionary. Languages
  with a lemma file (French first, below) match every inflected form.

### French recognition, and language rules as data (2026-11-03)

Owner, 18:53 JST, a French EPUB: "这里未识别的词有点多". On a public-domain
test text (Verne, _Le tour du monde en quatre-vingts jours_, Project
Gutenberg #800; 66k running words) **25.3% of running words** were
unrecognised. About half were inflected forms of lemmas our decks hold
(était, dit, yeux, fut, cette), a quarter dictionary words outside the
decks' 3,000 lemmas (paquebot, wagon), a fifth forms of those, plus names
missed after "Mrs." and in "l'Angleterre", and "coeur" for "cœur". Elision
with ’ and hyphenated clitics (dit-il) were already handled by the segmenter.
After: **0.6%** (English words in the novel: sir, bank, road; Roman
numerals; Hindi loans).

- **Lemma file** (`lib/read/lemma.ts`, built by
  `scripts/words/build-lemmas.ts` from kaikki.org English Wiktionary, CC BY-SA
  4.0): every headword with its forms, 2.5 MB (389 KB gzip), read by the server only.
  A book stores the entries its words need with its word count
  (`WordStats.lex`, once per book), so neither the ring nor the scan parses
  the file per request, and the device downloads none of it.
- **Matching:** a book word's folds include the headwords it is a form of,
  so a card or list entry for "regarder" covers "regarda", "regardaient".
  A word without a card is **new** when one of our lists or the reader's
  decks has it or its headword, or when the dictionary has it; otherwise
  unrecognised. The words route marks dictionary words for the device.
- **No per-language code** (owner, 19:05 JST, "你不要对任何语言有各种特殊处理"):
  one engine; elisions, endings, ligatures, folds, abbreviations, name rules,
  reading keys and stop words live in `lib/read/lang/<lang>.json`. A new
  language plugs in with a data file and, optionally, a lemma file.
- **Scan summary:** a few unrecognised words (most frequent first) shown
  inline, the full list a tap away; the button carries no count.
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
- **A Google Doc** (owner, 2026-11-04): paste a docs.google.com/document
  link on /read (behind the reader-v2 gate). The server reduces it to the
  doc id and fetches only Google's HTML export for it (`lib/gdoc/`; redirects
  only to Google's export hosts, inline images dropped while streaming, 8 MB
  of markup, 20 imports per 10 minutes per user). Works for docs shared
  "Anyone with the link"; private docs answer "not shared" until a Google
  connection exists (step 2: OAuth + /connections, after GCP setup).
  Headings stay headings, chapters start at the top heading level used more
  than once, bold/italic/super/subscript come from the export's class styles.
  `read_materials.source_key = "gdoc:<id>"`: importing the same doc again
  updates that book (same id); when its text changed, the sentence cards of
  unchanged lines are copied to the new sentence ids (`carrySentenceCards`),
  the old rows stay.
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
- **Built** (reader v2, behind `read.reader-v2`): the rules in
  `lib/read/reader-select.ts` (levels, fragments; unit-tested), the listener
  and highlight in `app/(app)/read/[id]/use-reader-select.ts`, the card in
  `reader-select-card.tsx`. Every level is drawn with the CSS Custom Highlight
  API (an attribute where it is missing), never the DOM selection, so the
  iOS selection menu never covers the card. The card takes the half of the
  screen away from the finger, so the next click lands on the book. Links
  name the book by its content hash; `/read/<hash>` redirects to the
  signed-in user's own copy of that text or answers 404
  (`lib/read/book-link.ts`). Gloss is a Wiktionary search in a new tab.
  **Translate is ours** (owner, 2026-11-04 14:58 JST: "dont [go to google
  translate], lets use ai credits and our api"): `POST /api/read/[id]/translate`
  (`lib/read/translate.ts`, `translate-server.ts`; the reader-v2 gate)
  translates the selected word … paragraph or hand-made range into the UI
  locale with the Learning Partner's model on Workers AI, and the card shows it
  under the text. Cached in D1 `read_translation` by SHA-256 of target + text
  (the text itself is not stored), so the same text and target are paid once;
  60 model calls per user per 10 min (a cost guard); the real cost goes to
  `chargeAi` (`gloss-server.ts`), the one charge seam until the credits
  redesign. "New to me" on a word logs a
  `select` exposure (no list API yet: extracts become cards later). QA:
  `scripts/qa/qa-read-select.mjs`.
- **Each level says its unit** (owner, 2026-11-03 22:12 / 22:13 JST: "点击选择
  某个词的时候，只要朗读那个词就可以了" / "连点三下，如果是选中句子的话，那就朗读整个
  句子"): a click reads aloud exactly what it selected — the word, the phrase,
  the sentence, the paragraph — never the item or the book on from there. A
  chapter or the book says nothing on a tap (too long; their card's "read
  from here" plays the book). A book playback running is paused and left
  paused, its current item unmoved (▶ resumes). The first click speaks at
  once, inside the gesture; each further click of the combo cuts what is
  being said and speaks its unit once the combo rests for the double-click
  interval, so a fast triple-click goes straight to the paragraph. Same
  speaker as the player (book-language voice or cloud TTS per voice-out, the
  mic hold and echo guard); a failure shows on the card ("Could not read it
  aloud (why)"). Rules: `tapVoice` in `lib/read/reader-select.ts`
  (`unit/read-tap-voice.test.ts`).
- **Manual selection** (owner, 2026-11-03 22:25 JST: "我手动选择一串内容的时候也会
  生成一个"): his own native selection of any extent — a long-press and the
  handles on a phone, a mouse drag on a desktop, across paragraphs — gets the
  same card, as the unit `range`. It is snapped to whole words (the first word
  that ends after the selection starts, to the last that starts before it
  ends; `snapIndices`), a single word is that word. The card appears once the
  selection settles (`selectionchange` quiet 350 ms with no pointer down, or
  a pointerup), on the side of the screen the selection leaves more room on,
  away from the native handles and menu; the native selection is never moved
  or cleared while he adjusts it. It offers the preview, its familiarity,
  copy text, translate, read from here, **read aloud** (exactly the selection,
  the same speaker and rules as a tap's), the link, 「复习选中内容的所有单词」
  (the review below, scoped to the selection's own words across its
  paragraphs, `spanWords`) and 制卡 (N) for those without a card. A tap
  elsewhere — in the book too — clears it; a tap on the card keeps it.
  Not a combo level: the next click in the book starts at the word. Link:
  `#r=<line>.<token>-<line>.<token>` (start before end, at most
  `RANGE_MAX_LINES` lines), opened, highlighted and flashed like the other
  units, under the same access rule (the fragment never reaches the server:
  no access is the same 404). QA: `scripts/qa/qa-read-manual-select.mjs`.

### Review a range's words (owner, 2026-11-03 22:17–22:27 JST)

"单击这个段落的时候……显示一个『复习该段落所有单词』的按钮……点这个按钮，出来一个
popup"; "点复习按钮后弹出的 = 单词列表复习 UI"; "继续用我在单词列表的卡组之前的进度";
"如果这一堆里有任何一个我还没有打入进我的卡组的话……『制卡』按钮".

- **Trigger:** one button on the selection card at the word, phrase,
  sentence and paragraph levels — the paragraph holding the selection
  (`openReview` in `ReaderV2.tsx`, the one place to change it). Not the
  Again swipe, not the rail.
- **The popup is /words' own review:** `Study` of `WordsClient.tsx` with a
  `scope` (its rows, swipe, mirror, undo, marks, FSRS cards, grades sent
  through `/api/words/lists/<id>/review`), over the book
  (`reader-word-review.tsx`, loaded on open). Scoped: only these words, no
  new-word intake, no more due words, the page under it not locked. Order:
  unrecognised, new, learning weakest first, then the known ones
  (`lib/read/word-review.ts` `orderWords`). A card not due yet is left out
  until its due (`scopeSession`, `isDueCard`; owner, 2026-11-04 19:28 JST:
  "lorsque" graded Easy came back in the same paragraph's review); every
  word not due yet → the review opens already done.
- **Which card:** a word that has a card in any of his lists in the book's
  language — matched with the reader's folds and lemmas, as the marks are —
  is reviewed on that card, its progress kept. Several lists: the card
  reviewed most recently, then due soonest, then list id (`matchCard`). Only
  a word with no card anywhere comes as a new word of **the book's own list**
  (`source = "book:<content hash>"`, named after the book, made on first
  need, entries in `word_list_entries` like an Anki import). Names without a
  card are left out. `POST /api/read/[id]/word-session`.
- **制卡:** on the card and at the top of the popup, with the count of words
  that have no card (by the word map: new or unrecognised). Makes an
  unreviewed card (due now) for each in the book's list, meaning from our
  catalogs, the sentence as example; never a second card
  (`lib/read/book-word-list.ts` `makeCards`). The toast's Undo removes the
  ones still unreviewed. `POST /api/read/[id]/make-cards`.
- **Every word with a meaning** (owner, 2026-11-04 14:41 JST, Le Petit
  Prince: "有好几个词只有例句没有解释" → "用AI自动补上"). The device looked our
  decks up without the book's lemmas, so "représentait", "avalait",
  "appelait" had no meaning, and "fauve", "boa" are in no deck at all. Now
  the server fills every word lacking one (`lib/read/gloss.ts`,
  `gloss-server.ts` `fillGlosses`), first hit wins: the decks over the
  word's folds with the lemmas; the shared generated glosses (D1
  `word_gloss`, keyed by language + headword, not personal data); the model
  (Workers AI, the Learning Partner's DeepSeek, English Wiktionary-style
  like the decks), written to `word_gloss` first so no word is generated
  twice. Only words that need one are looked up: a new word, or a card made
  without a meaning — that card (and its entry) is backfilled, only where
  its back is still empty. Per user, a rate limit on model calls.
  **Cost:** each generation's real cost (the model's token counts × its
  list price) goes to `chargeAi`, the one place a credits debit will go;
  until the credits redesign (owner, 2026-11-04) it only logs
  `read.gloss.cost`.

### Side-by-side word review (owner, 2026-11-04 15:56 JST; flag `read.side-review`)

A /words-style review **inside** the reader, PC first: the book stays on
screen and ONE card sits beside it (a phone: over the bottom of the book,
above the pill). Off for everyone but the owner until the flag is on.

- **Open:** the ⧉ button on the reader's pill, or `?side` on the book's URL.
  It starts at the first due word from the eye line, else the first new one,
  silently; a jump or a grade then says the word, as a focus change on /words.
- **Jump:** `D` / `N` the next word of the text due on his cards / new to
  him (no card; a list's or the dictionary's word, the marks' `n`);
  `Shift+D` / `Shift+N` back; the card's ‹ › buttons do the same. A click
  on any word shows that word's card. The focused word is marked in the text
  (`data-side-focus`) and scrolled to the eye line when off screen.
- **Due:** GET `/api/read/[id]/word-due`: the book's words whose card (any
  of his lists in the book's language) has `due` ≤ now, by the same folds as
  the word map (lib/read/side-review.ts `dueBookWords`). Read once on open.
- **The card:** the word as /words has it (POST word-session for that one
  word: his card, or a new word of the book's list, with the #507 gloss),
  its reading, status (new / due since / not due yet), and everything at
  once (owner, 19:53 JST: no reveal step): meaning, the book's sentence, 🔊.
  Grades: 1–4 and
  L K J H as /words (`keyRating`, lib/words/swipe.ts), through /words' own pending queue
  (`queueWordReview`); a new word's entry joins the book's list as in the
  paragraph review. After a grade: the next word of the same kind, then of
  the other. `Z` takes the last grade back and returns to that word. `Esc`
  or back closes; the word marks refresh then.
- **本段单词 on PC** (owner, 2026-11-04 19:31 JST): on a wide screen the
  selection card's "review the paragraph's words" opens the panel, not the
  overlay: the paragraph's (or selection's) words above the card, each with
  his progress (due, mastered / learning / new / unrecognised, or the grade
  just given); a pick shows its card, a grade moves to the next word of the
  list that is due or new. A phone keeps the overlay review.
- **Never lands on a card not due yet** (owner, 19:43 JST): D / N, the
  auto-advance and the list's next offer due and new words only; a click
  still opens any word (word-session `all`, past #527's due filter). A word
  the session leaves out shows its word and meaning with 制卡; only a failed
  request shows the error, with a retry.
- While it is open the reader's own item keys (1–4, H J K L, Space) rest.
- No gesture starts at a screen edge (Android's Back): no card swipe yet;
  grade by buttons and keys. The shared edge-safe swipe can come later.

### No chunks in the reader (owner, 2026-11-03 ~18:50 JST)

"阅读模式不用我们主动分块", after "不要给用户规划任何死数字 … 我们不要用任何数量数字".
This supersedes the chunk design above for the reader:

- The reader never splits the book into chunks and never sets a daily
  portion. He reads continuously; there is no "today 3/3" divider and no
  "N chunks a day".
- What counts is what he actually read: a high-water mark (the furthest
  paragraph that passed the reading line with real reading time), stored
  with the position. Progress is shown only as proportions (share of the book
  read, coverage against the 95% line), never as counts of units.
- Word and phrase extraction runs on the paragraphs he has read, in the
  background, as the high-water mark moves (idempotent per paragraph hash);
  no "读完" button is needed for it.
- Pace toward a target date, if he sets one, is shown as a proportion or as
  time, derived from his own reading speed, never as a fixed amount.

### Incremental reading (owner, 2026-11-03 ~19:00 JST)

"我们采用渐进阅读概念" — SuperMemo-style incremental reading, on the book's
own paragraphs (no chunks):

- **The book is a topic.** He reads continuously; every paragraph he has read
  joins review scheduling (FSRS, like page cards). Paragraphs he finds less
  familiar come back sooner. Coming back means the reader takes him to that
  paragraph, not a pop-up card.
- **Each read is a review.** "用户可能同段落会读很多次，每次有新的理解". After a
  paragraph he may grade his understanding (Again / Hard / Good / Easy, as on
  cards) — that grade drives the paragraph's FSRS schedule; without a grade,
  dwell time and look-ups give an inferred one. He can attach a note to each
  read; the paragraph shows the history of grades and notes (like a word's
  stamps), so deepening understanding is visible.
- **Paragraph familiarity** combines the familiarity of its words, phrases
  and concepts with his own paragraph grades, so a paragraph whose words are
  all known but which he hasn't understood is not counted as mastered.
- **Extracts become cards.** What he picks out with combo-click (word,
  phrase, sentence) becomes its own card; auto-extraction adds unpicked new
  words to the book's list in the background.
- **Words seen in context (decided: option A).** A paragraph grade is not
  copied onto its words. Risks: inflation (guessed words "learned"),
  false failures (one hard word fails every word), same-day flooding of
  common words, recognition ≠ recall. FSRS (ts-fsrs 5.x) has no weak/partial
  rating. So, first, "seen in context" goes into a separate **exposure log**
  only, used to reorder reviews (recently seen words later), never changing
  FSRS state. Only explicit actions (looking a word up, selecting it,
  marking it in a note) count as "not recognised". After collecting data,
  check whether exposures predict later recall; if so, consider option B
  (one Good, near-due only, once a day, tagged "from reading").

### Owner decisions, 2026-11-03 ~19:40 JST (Slack)

1. **Shared catalogue rule:** public domain in the US **and** every creator
   (translators included) dead 80+ years.
2. **No book-page layout.** The reader renders the EPUB's own paragraphs as
   they are, in one continuous scroll; **swiping a paragraph left/right is
   its review grade**, exactly like the /words swipe (the mirror setting
   applies). This replaces both layout options A and B above.
3. "轮到你" (wait-for-you after each read-aloud line) was unclear to him;
   explained as the shadowing pause. Open: whether reading aloud should
   default to continuous.
4. **Bottom nav shrinks to its capsule while reading.** A unified
   minimise/collapse rule set is being compiled.
5. **Marks follow each word's familiarity**, and paragraphs show their
   vocabulary familiarity. Asked whether mastered words should also get a
   (very faint) mark.
6. **Real-world statistics stay** (word counts, scan summary): they are the
   user's real data, not numbers we prescribe.

## Review units (owner, Slack 2026-11-03 ~19:45–20:00 JST)

The owner's final design for what the reader reviews. Built behind the flag
`read.reader-v2` (off by default; always on for the owner). Contract:
`lib/read/reader-api.ts`; pure libs `lib/read/units.ts` (segmentation, ids,
items) and `lib/read/familiarity.ts` (aggregation); store
`lib/read/reader-store.ts`; tables `db/migrations/0030_reader_v2.sql`.

- **The atomic unit is the sentence.** A line (paragraph or heading) is cut
  with `Intl.Segmenter` (granularity `sentence`, the book's language); a cut
  after one of the language's abbreviations (`lib/read/lang/<lang>.json`
  `abbreviations`: "Mrs.", "M.") is undone, and a piece with no letter or
  digit joins the sentence before it. No language branches in code. Its id is
  `<book hash>:<line>.<index>`: the book hash is the first 16 hex digits of
  SHA-256 over the book's plain lines joined by newlines, so the same text
  imported again (by anyone, any time) has the same ids, and emphasis added
  later does not change them. The server is the only place that segments;
  the UI takes sentence ranges from the items API. Each card also stores a
  short hash of its sentence's text, so a segmenter (ICU) update that moves
  cuts can be detected and remapped by line + text.
- **FSRS state lives on sentences** (`read_sentence_cards`, ts-fsrs 5.x with
  its default parameters, as page cards). One row per user per graded
  sentence.
- **An item is a run of whole sentences**, what one swipe grades. The user
  picks the granularity: sentence, paragraph, or by time. Grading an item
  grades each of its sentences with the same rating, so changing granularity
  loses no history. Item bounds are reading time, never screen size or
  counts:
  - estimated time = the item's word-like segments ÷ the user's reading speed
    in that language (median words per second over their graded reads);
  - **lower bound**: consecutive short units merge until the item takes at
    least this long; **upper bound**: a longer unit is split at sentence ends
    so each part stays within it. Items never cross a chapter.
  - From the user's own reads (`read_reviews.dwell_ms`: from the item coming
    into view to the swipe, sent by the UI): lower = their 10th-percentile
    read before a swipe, upper = their 90th percentile; used once there are
    enough reads for a 10th percentile to exist (10).
  - Before that: lower = 3 s (the upper end of the 1–3 s a person takes to
    react to information, design-principles.md), upper = none (the chosen
    unit unsplit), speed = 238 words a minute (Brysbaert 2019, silent
    reading), replaced by the user's own speed as soon as it exists.
  - By time: sentences packed (across paragraphs, within a chapter) until the
    chosen span; the span defaults to the user's median read, and before data
    to the lower bound. Same algorithm.
- **Familiarity aggregates upward**: sentence → item / paragraph → chapter →
  book, each a token-weighted mean (a sentence weighs its running words):
  - vocab: mean word score (`lib/words/progress.ts` wordScore; names = 1);
  - coverage: share of running words mastered or names (the 95% rule);
  - grade: mean sentence FSRS score on the same log scale (never graded = 0);
  - understood: share of running words in sentences last graded Good/Easy;
  - shown value = min(vocab, grade): a sentence whose words are all known but
    which was never understood is not familiar.
  - **Book pass (reader v2)** = word coverage ≥ 95% (the existing ✓) **and**
    understood ≥ 95%: the same line applied to sentences, no new threshold.
    The stored `passed_at` stays the word-coverage pass.
- **Words seen in context: exposure log only** (option A, decided).
  `read_exposure_events` (one row per user, sentence, kind, word, day: a
  resend is a duplicate) and `read_exposures` (per user, language, word, day:
  seen and explicit counts). "seen" = the sentence passed the reading line;
  "lookup" / "select" / "note" = an explicit "not recognised". Never changes
  a word's FSRS state.
- **Reading position synced** (`read_progress`): anchor (line, offset 0..1)
  where the newest client time wins, and the high-water line that only grows;
  the response names the lines it just moved over, the extraction trigger.
  Written by the UI when scrolling stops and on `pagehide` (sendBeacon POST);
  no polling.
- **Notes per read** (`read_notes`): optional text on an item, tied to the
  read it was written on; edits keep the earlier texts with their times;
  delete is soft. History of an item = its reads (`read_reviews`) and notes.
- **Inline emphasis and in-paragraph line breaks** from the EPUB (#448
  dropped them). The stored `lines` stay plain text, unchanged, so counting,
  read-aloud and ids keep working; `BookMeta` gains `marks` ([line, start,
  end, kind], kinds em / strong / sup / sub only, checked on the server),
  `breaks` (lines that continue the paragraph after a `<br>`) and `continues`
  (lines that continue a long paragraph split at import), and `markup: 1`.
  Books imported before have none and render as before. The EPUB itself is
  not stored, so the markup comes back when the same EPUB is imported again:
  same plain text (same hash) → the existing book is upgraded in place (same
  id, same history), not duplicated. The hash is backfilled into
  `read_materials.content_hash` on next open.
- **Scope.** Every route checks the session, the flag (or owner), and that
  the material is the user's own; every query is keyed by `user_id`.
  Deleting a book deletes its reader rows.

### Built: the reader v2 UI (2026-11-03, behind `read.reader-v2`)

`app/(app)/read/[id]/ReaderV2.tsx` (rows: `reader-blocks.tsx`). The old reader
stays while the flag is off; the owner always gets v2, on lianki.com too (the same rule as its backend, `readerV2On`).

- The whole book on the window's scroll, virtualised (`@tanstack/react-virtual`,
  measured heights); the EPUB's paragraphs, headings, emphasis and joins as
  they are; `data-line` / `data-s` / `data-t` on paragraphs, sentences and
  words for the combo-click layer.
- Items, sentence cuts, grades and the position from the backend (#480,
  `lib/read/reader-server.ts`); guests and MongoDB derive them on the device
  (`lib/read/reader-adapter.ts`). A grade waits 8 s before it is sent, so
  Undo can drop it: the grade API has no take-back. Only graded items move
  the high-water mark.
- Word marks by line style (solid learning, dotted new, dashed unrecognised),
  item familiarity as a left rail; swipe to grade with the /words core (both
  variants, mirror); read-aloud per item, then it waits for the swipe; chrome
  steps back only on his own scroll (`lib/read/reader-chrome.ts`,
  `lib/nav/reading.ts`).
- QA: `scripts/qa/qa-read-reader.mjs` (iPhone and Android, light and dark,
  both swipes, a long book under 4× CPU throttling).
