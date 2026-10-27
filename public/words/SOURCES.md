# Word list sources and licenses

Data for the `/words` fast vocabulary review. Each list file also carries its
own `source` and `license` fields. Lists are term + reading + short English
back only; no Anki templates or card designs were copied.

## Rebuild

```bash
bun scripts/words/build-word-lists.ts <raw-dir> public/words
```

The download commands are in the header of
[`scripts/words/build-word-lists.ts`](../../scripts/words/build-word-lists.ts).
Put downloads in a scratch dir outside the repo. Kaikki extracts are streamed
through `scripts/words/filter-kaikki.ts`, which keeps only the headwords that
appear in the frequency list. `WORDS_ONLY=fr,ja` rebuilds a subset and leaves
the other lists in `index.json` alone.

## Japanese: JLPT N5–N1 (`ja-jlpt-n*`)

- Vocabulary, kana readings and meanings come from
  [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks)
  (`src/n*.csv`, MIT). That data came from
  [chyyran/jlpt-anki-decks](https://github.com/chyyran/jlpt-anki-decks), which
  is based on Jonathan Waller's JLPT lists at [tanos.co.uk](http://www.tanos.co.uk/jlpt/)
  (CC BY). Attribution: "JLPT vocabulary lists by Jonathan Waller, tanos.co.uk".
- The order within a level follows the OpenSubtitles frequency in
  hermitdave/FrequencyWords `ja_full.txt` (see below). A word's rank is looked
  up by its written form, then its kanji stem without trailing okurigana, then
  its reading. Words with no match keep source order at the end. Because the
  frequency list is tokenized in its own way, the order is only approximate.
- `reading` is left empty when it is the same as the term (kana-only words).
  Grammar notes such as "(〜を)" are removed from readings. When one written
  form has several readings in a level, they are merged into one card: 外 has
  reading "そと・ほか" and back "outside, exterior; other, the rest". Terms
  are therefore unique within each list.
  JLPT levels are unofficial: JLPT has not published a word list since 2010.

## Chinese: HSK 3.0 levels 1–6 and 7–9 (`zh-hsk-*`)

- Word lists, pinyin, meanings and frequency ranks come from
  [drkameleon/complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary)
  (`wordlists/exclusive/new/*.min.json`, MIT). Its HSK 3.0 lists come from
  elkmovie/hsk30. Its English definitions come from
  [CC-CEDICT](https://cc-cedict.org/) (CC BY-SA 4.0).
- Words are ordered by the dataset's frequency rank. Senses that only say
  "surname …", "variant of …" or "abbr. …" are dropped when the word has
  other senses. For a word with several readings, the common-noun reading
  with the most senses is used (以 yǐ, not Yǐ "Israel"). `zh-hsk-7-9` is
  the combined advanced band, with 5,606 words.

## Frequency bands: fr, es, de, en, ko, it, pt, ru (`<lang>-freq-1..6`)

- Ranks come from [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords),
  `content/2018/<lang>/<lang>_50k.txt`. The ranks are built from the
  OpenSubtitles 2018 corpus (opus.nlpl.eu). License: CC BY-SA 4.0.
- Glosses are English Wiktionary content, taken from the per-language
  [kaikki.org](https://kaikki.org/dictionary/) extracts made with wiktextract
  (Tatu Ylonen). Wiktionary text is dual-licensed CC BY-SA 4.0 and GFDL.
  Attribution: "Definitions from English Wiktionary (en.wiktionary.org)
  contributors, via kaikki.org".
- Cleaning steps:
  - Tokens are dropped if they use the wrong script, contain digits, or end
    in an apostrophe or hyphen (elisions such as `n'`).
  - Single-letter tokens are dropped unless they are function words (`à`,
    `y`, `и`).
  - Entries whose only meaning is a proper name, letter, symbol, affix,
    abbreviation or phrase are dropped.
  - Senses tagged offensive, derogatory, pejorative, slur or ethnic, and
    senses whose text says so, are never used. The same goes for senses
    tagged obsolete, archaic, rare, dated, historical, dialectal, nonstandard
    or misspelling.
  - Senses tagged slang, colloquial, informal, euphemistic, vulgar, humorous,
    regional, Internet or childish, regional French (Quebec, Belgium, …) and
    "short for …" senses are used only when the word has no neutral sense.
    Example: `chance` is "chance; luck", without the euphemistic slang sense.
  - Pronoun and determiner forms keep their own card, with the meaning
    Wiktionary gives after the lemma: `me` "accusative of yo: me" becomes
    "me".
  - Inflected forms that Wiktionary marks `form-of` are folded into their
    lemma (`est` → `être`), and the lemma takes the rank of its first form.
    Duplicates are removed. A word that is also a lemma in its own right
    stays itself, unless the lemma it is a form of is in the top 10,000
    (`terre` stays "earth"; it does not become the rare verb `terrer`).
  - Only German, which capitalizes nouns (`zeit` → `Zeit`), and English `i` →
    `I` may match a capitalized headword.
  - The first ~3,000 usable lemmas are kept, in six bands of 500.
- The back is at most 80 characters with 1–3 senses. Senses from a second
  part of speech are prefixed with it, e.g. `(noun)`. Long definitions lose
  their parenthetical usage notes.
- The part of speech that leads is chosen this way: closed-class words
  (pronoun, article, determiner, preposition, conjunction, particle) first,
  then the entry with the most senses. Within an entry, glosses go before
  descriptive definitions ("Used as …", "Denotes …").
- A few top function words have only descriptive Wiktionary definitions, or
  get a minor sense first. Their backs are hand-written in `OVERRIDES` in the build
  script: French pas, vous, nous, du, se; Spanish bien; Italian bene.
- English uses kaikki's English dictionary, so its backs are short English
  definitions rather than translations. They keep Wiktionary's order, with
  the main etymology and main sense first, and give the first definition
  plus a second sense or part of speech if it fits. Pieces of contractions
  in the subtitle tokens are dropped (`don`, `ll`, `ve`, …).
- Known caveats:
  - Korean tokens are subtitle eojeol, so particles stay attached and some
    homonyms get odd glosses. Only tokens with their own Wiktionary entry
    survive. Treat the Korean lists as rougher than the others.
  - Folding into lemmas can drop a homograph's own meaning. French `été`
    (summer) is folded into `être`.

## Licensing summary

Lists built from CC BY-SA sources (all frequency bands, the HSK lists via
CC-CEDICT, and the ordering of the JLPT lists) are redistributed under
CC BY-SA 4.0 with the attribution above. Changes made: filtering, lemma
folding, truncation and reordering.
