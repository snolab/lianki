# Word list sources and licenses

Data for the `/words` fast vocabulary review. Each list file also carries its
own `source` and `license` fields. Lists are term + reading + short English
back, plus an optional example sentence with its translation; no Anki
templates or card designs were copied.

## Rebuild

```bash
bun scripts/words/build-word-lists.ts <raw-dir> public/words
```

The download commands (frequency lists, kaikki extracts, JLPT/HSK lists,
Tatoeba exports) are in the header of
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
- Kaikki extracts are filtered with `scripts/words/filter-kaikki.ts`. When a
  Wiktionary sense is only a heading ("Figurative senses.", "Senses relating
  to …"), its sub-definition is used instead. Sense topics (heraldry,
  Buddhism, …) are kept. For Korean, the filter also keeps every verb and
  adjective that has a conjugation table, together with its table forms
  (`KAIKKI_FORMS=1`).
- Cleaning steps:
  - Tokens are dropped if they use the wrong script, contain digits, or end
    in an apostrophe or hyphen (elisions such as `n'`).
  - Single-letter tokens are dropped unless they are function words (`à`,
    `y`, `и`).
  - Entries whose only meaning is a proper name, letter, symbol, affix,
    abbreviation or phrase are dropped. So are notes that are not meanings
    ("Indicating a surname …", "Thai (language)").
  - Senses tagged offensive, slur or ethnic, and senses whose text says
    so, are never used. The same goes for senses tagged obsolete, archaic,
    rare, dated, historical, dialectal, nonstandard or misspelling.
  - Senses tagged derogatory, pejorative, slang, colloquial, informal,
    euphemistic, vulgar, humorous, regional, Internet or childish, regional
    French (Quebec, Belgium, …) and "short for …" senses are used only when
    the word has no neutral sense. Example: `chance` is "chance; luck",
    without the euphemistic slang sense. These do not count as slang:
    informal register on pronouns and interjections (French `ça` "that"),
    Korean speech-level tags (`너` "you"), and English informal or childish
    tags (`mommy` "mother").
  - Senses in specialist fields (heraldry, Buddhism, tarot, chess, linguistics,
    …; the list is `TECH_TOPICS` in the build script) are used only when a
    word has nothing else. Example: `parti` is "party", not the heraldry term
    "per pale".
  - Pronoun and determiner forms keep their own card, with the meaning
    Wiktionary gives after the lemma: `me` "accusative of yo: me" becomes
    "me".
  - Inflected forms that Wiktionary marks `form-of` are folded into their
    lemma (`sont` → `être`, `fue` → `ser`), and the lemma takes the rank of
    its first form. Duplicates are removed. A form of a rare word stays
    itself (`terre` stays "earth"; it does not become the rare verb `terrer`).
  - Homographs are words that are lemmas in their own right and also forms
    of a common word. They keep their own card, and the lemma they are a
    form of is counted too:
    - If that lemma is in the top 400 tokens and the form is a common one
      (not a subjunctive, conditional, future or literary tense), the form
      goes first and the word's own meaning follows. Examples: `été` is "past
      participle of être (“to be”); (noun) summer", and `est` is "3rd sg.
      present of être (“to be”); (adj) east".
    - The same applies, up to rank 3,000, to French, Spanish and Portuguese
      nouns that almost never appear in the plural (`pienso` "I think" before
      "fodder").
    - Otherwise the word's own meaning leads. Examples: `casa` "house" (also
      a form of `casar`), `nuit` "night" (also a form of `nuire`), `porte`
      "door".
    - Forms of pronouns and determiners (`essa`, `einen`, `meus`) fold into
      the function word. The exception is a token that is also a verb in its
      own right (German `meinen`, `lieben`).
  - Only German, which capitalizes nouns (`zeit` → `Zeit`), and English `i` →
    `I` may match a capitalized headword. A German token that is an adverb,
    interjection or verb form in its own right is not sent to a noun
    (`ja`, `hier`, `nein`, `habe` → `haben`, not `Ja` "a yes" or `Habe`).
  - English tokens are lowercased, so first names and places look like rare
    words. A token is skipped when Wiktionary has a first-name or place entry
    for it, the lowercase word has at most two senses and no adjective, and
    its plural does not occur (`kyle`, `steve`, `vega`).
  - Korean tokens are eojeol, so particles and endings are attached. Each
    token is analysed with `scripts/words/korean.ts` as one of:
    - a pronoun with a fused particle (`난` → `나`, `널` → `너`);
    - a conjugated verb or adjective (`팔고` → `팔다`, `할` → `하다`). This uses
      Wiktionary's conjugation tables plus regular endings built from the
      stem, the infinitive and the past stem;
    - a noun with a particle or copula. Particles must match the noun's final
      sound (`사람이`, `너를`, `거야` → `것`).
    When a token has both readings, the more frequent one wins (`우리는` is
    `우리` + `는`, not a form of `우리다`). The token's own entry is kept in
    three cases: it is a native adverb, pronoun, determiner or interjection,
    or a Sino-Korean adverb such as `절대`; it is a noun that occurs with
    particles of its own in the frequency list (`해가`, `말을`); or it is a
    dictionary-form verb. Otherwise obscure homonyms are dropped: `팔고`
    "eight Duḥkhas", `대한` "great khan", `할` "a tenth". A lone Sino-Korean
    syllable (`서` "west") needs the same particle evidence. Sino-Korean
    homonyms rank after native words.
  - The first ~3,000 usable lemmas are kept, in six bands of 500.
- The back is at most 80 characters with 1–3 senses. Senses from a second
  part of speech are prefixed with it, e.g. `(noun)`. Long definitions lose
  their parenthetical usage notes.
- The entry that leads the back is chosen as follows:
  - Pronouns, articles, determiners and prepositions come first (`pas` is
    "not" before "step"). Conjunctions and particles come first only when
    Wiktionary lists them first: `ob` leads with "if", but `aussi` is "too",
    not "therefore".
  - After that, Wiktionary's entry order decides, since the main etymology
    and main part of speech are listed first. `maison` is "house" before the
    adjective "homemade", and `petit` is "small" before "little one".
  - A much richer later entry can still win, and verbs get a small boost
    (`devenir` is "to become", not the noun "future").
  - Entries whose best sense is a description ("The inanimate subject
    interrogative pronoun") rank last. So do entries with only slang or
    specialist senses.
  - When a word has two etymologies with the same part of speech, both main
    senses are shown (`livre` "book; pound").
  - Within an entry, glosses come before descriptive definitions ("Used as
    …", "Denotes …").
- A few top words have only descriptive Wiktionary definitions, or their
  most common use is not the one the data puts first. Their backs are
  hand-written in `OVERRIDES` in the build script:
  - French: pas, vous, nous, du, se, bien, là, plein, tour.
  - Spanish: bien.
  - Portuguese: tu.
  - Italian: bene, ora.
  - German: sein, der, ja, für, wer, sich.
  - Russian: это, бы, есть, то.
  - Korean: 네, 예, 내, 제, 못, 안, and the copula 이다.
- English uses kaikki's English dictionary, so its backs are short English
  definitions rather than translations. They keep Wiktionary's order, with
  the main etymology and main sense first, and give the first definition
  plus a second sense or part of speech if it fits. Pieces of contractions
  in the subtitle tokens are dropped (`don`, `ll`, `ve`, …).
- Known caveats:
  - The Korean analysis is heuristic. Some cards still show a Sino-Korean
    homonym, and some rare verbs are reached through a common ending.
  - When a homograph's form reading leads, the card shows a grammatical note
    ("past participle of être (“to be”)") rather than a translation.
  - Order follows Wiktionary's entry order. A few words still lead with a
    less common part of speech (`fini` shows the noun first).

## Example sentences (`ex`, `exTr`, all lists)

Each entry may have one example sentence (`ex`, ≤ 80 characters) and its
English translation (`exTr`, ≤ 100 characters; none for the English lists).
Entries with no suitable sentence leave both fields out.

- **Wiktionary usage examples** come first. They are the `examples` of the
  entry's main senses in the kaikki extracts. Dated quotations, phrases
  without final punctuation, and examples with digits or a citation in the
  translation are skipped. Only the entry whose sense the back leads with is
  used, so `maison` does not get the adjective's "in-house" example. Words
  with a hand-written back get no Wiktionary example. Russian stress marks
  are removed. A Wiktionary example longer than 60 characters gives way to a
  Tatoeba sentence that is more than 20 characters shorter.
- **Tatoeba** ([tatoeba.org](https://tatoeba.org), per-language exports and
  their links to English sentences) fills the gaps, and is the only source
  for JLPT and HSK. License: CC BY 2.0 FR (some sentences CC0). Attribution:
  "Example sentences from Tatoeba (tatoeba.org) contributors". The shortest
  sentence that contains the word is chosen. It must have at least three
  words, or for Japanese and Chinese at least four more characters than the
  word.
  - For fr, es, de, en, it, pt, ru and ko, the sentence may contain any
    subtitle token that resolved to the lemma (`팔지` for `팔다`, `sont` for
    `être`). The exact form is preferred.
  - A lowercase word that only appears capitalized mid-sentence is a name
    there, so "Me llamo Marina." is not used for `marina` "navy".
  - Japanese and Chinese are matched as substrings. A match inside a longer
    word from the same lists does not count (`白` in `面白い`, `问` in `疑问`).
    Japanese also accepts a kana reading of three or more characters.
    Sentences with Han characters outside the JLPT/HSK vocabulary are skipped,
    which keeps them simple and removes traditional characters from the
    Chinese lists.
  - A sentence already used for another entry counts as 15 characters
    longer, so sentences are not repeated across a list.
- Coverage: fr 98%, es 99%, de 99%, en 99.8% (examples only), it 99%,
  pt 98%, ru 98%, ko 65%, ja 90%, zh 66%.

## Licensing summary

Lists built from CC BY-SA sources (all frequency bands, the HSK lists via
CC-CEDICT, and the ordering of the JLPT lists) are redistributed under
CC BY-SA 4.0 with the attribution above. The example sentences from Tatoeba
are CC BY 2.0 FR, attributed above. Changes made: filtering, lemma
folding, truncation and reordering.
