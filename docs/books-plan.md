# Books: a public-domain library you can actually read (plan)

Owner's vision, 2026-11-03 15:15–16:33 JST. Design only; nothing here is
built yet except EPUB import on /read (#448).

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

## A first multilingual text: the Bible

The owner's example (16:34 JST): many language editions, mostly free to use,
chosen for language-learning value, not to promote a religion (present it
neutrally, alongside other classics). Check every edition:

- Public domain in the US and elsewhere: Louis Segond 1910 (fr), Luther 1912
  (de), Reina-Valera 1909 (es), 和合本 1919 (zh), Synodal 1876 (ru), World
  English Bible (en, explicitly public domain).
- **KJV is not free in the UK**: the Crown's letters patent still control it
  there. Use the World English Bible for English, or gate KJV by country.
- Modern translations (NIV, ESV, 新共同訳, 新改訳 …) are copyrighted: never.
- Japanese: 文語訳 (明治元訳/大正改訳) is public domain; check 口語訳 (1955)
  before use.

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
3. Free monthly quota for own uploads; credits beyond it?
4. v1 owner-only behind a flag?
5. Accept the own-upload legal risk (ToS + takedown contact)? **Decided
   2026-11-03 (Slack): yes — a user's own upload is fine as long as it is
   never shared** (private, unlisted, deletable).
