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

## Scenario phrase decks: ja, zh (`<lang>-phrases-<scenario>`)

Short everyday phrases sorted by situation, about 30 per deck, most common
first. There are twelve scenarios, in this order: greetings and introductions,
small talk, restaurant and café, shopping and paying, transport and
directions, hotel and travel, work and office, school and class, health and
pharmacy, phone, messaging and online, emergencies and police, and feelings,
thanks and apologies. They are rows of index.json with `kind: "phrase"` and
`scenario`. The picker files them under language → Phrases → scenario. The
ids, English names and checks are in `lib/words/phrases.ts`.

- **Entries.** Each entry has these fields:
  - `term`: the phrase. At most 20 characters in Japanese and 14 in Chinese.
    No digits, and no Latin letters except loanwords written as is (WiFi,
    LINE, OK…).
  - `reading`: kana for Japanese, pinyin with tone marks for Chinese.
  - `back`: a natural English equivalent, not a word-for-word gloss. As in
    the other lists, it is in English.
  - `note`: who says the phrase to whom, and when, in English.
  - `register`: `casual` or `polite`.
  - `scene`: the moment within the scenario, such as "ordering".
  - `src`: the Tatoeba sentence's link, `https://tatoeba.org/sentences/show/<id>`,
    or `generated`.

  A Japanese phrase is read aloud as written, not from its kana.
- **Tatoeba first.** The candidates are Tatoeba sentences
  ([tatoeba.org](https://tatoeba.org), CC BY 2.0 FR) that meet all of these:
  - written by a user who declares the language native, i.e. skill 5 in the
    `user_languages` export;
  - short;
  - linked to an English translation;
  - for Chinese, in simplified characters only.

  Sentences first written in the language are preferred over translations
  (`sentences_base`). `scripts/words/phrase-candidates.ts` builds the
  candidates. A Tatoeba phrase is used unchanged, apart from its final
  punctuation mark. The English `back` may be reworded.
- **Generated lines.** Where Tatoeba has nothing natural for a common line
  (お会計お願いします, 麻烦买单, 扫码付款可以吗), the line was written for
  Lianki, and its `src` is `generated`.
- **How they were chosen.** Workers AI was not used. Language-model agents
  (Claude) did these steps:
  - sorted the candidates into scenarios by keyword pools and by reading
    them;
  - ranked them by how common they are;
  - wrote the notes and the generated lines.

  The rule was "would a native speaker actually say exactly this here",
  with casual and polite lines mixed.
- **Checks.** A second model (Claude Sonnet) then reread every line for the
  same question. It also looked for calques: from English (needless 私は,
  你/我, 「进行」…), and, for Japanese, from Chinese. It checked the register,
  the note, the English and the reading. Its drops were removed and its
  fixes applied. A fixed Tatoeba line becomes `generated`. Script checks
  (`phraseProblems`, and the deck tests in `unit/words-phrases.test.ts`)
  cover:
  - length;
  - script: kana in Japanese, no kana or traditional characters in Chinese;
  - registers and `src` links.

  During curation, the pinyin was also checked against CC-CEDICT readings
  syllable by syllable, and each Tatoeba line against its sentence.
- **Owner review.** Every phrase is in a review sheet (keep / edit / drop),
  with its source and the second check's verdict. Lines the owner drops go in
  `scripts/words/phrases/drop.tsv` (`lang<TAB>term`), and the build leaves
  them out.
- **Rebuild:**
  `bun scripts/words/build-phrase-decks.ts scripts/words/phrases public/words`.
  It reads the curated `scripts/words/phrases/<lang>-<scenario>.jsonl`. Those
  files also hold each Tatoeba sentence's author (`by`). The build writes the
  decks and their index.json rows, and leaves the word lists alone.
  `build-word-lists.ts` in turn keeps the phrase rows. It also rewrites the
  credits below.
- **Audio.** Recorded voices come from `scripts/voice/texts.ts`, which reads
  every list in public/words, phrases included. Until the clips are rendered
  and uploaded, Japanese and Chinese phrases use the MeloTTS fallback.

Per-sentence credits: each deck's Tatoeba sentences, linked by id, with their
authors (CC BY 2.0 FR).

<details><summary>Tatoeba sentences in the phrase decks</summary>

<!-- phrase-credits:start (build-phrase-decks.ts writes this) -->

- `ja-phrases-greetings`: [#3553332](https://tatoeba.org/sentences/show/3553332) arnab, [#373351](https://tatoeba.org/sentences/show/373351) tommy_san, [#9699149](https://tatoeba.org/sentences/show/9699149) Sim5634, [#3326557](https://tatoeba.org/sentences/show/3326557) e4zh1nmcz, [#10573391](https://tatoeba.org/sentences/show/10573391) small_snow, [#10837245](https://tatoeba.org/sentences/show/10837245) small_snow, [#175045](https://tatoeba.org/sentences/show/175045) bunbuku, [#400933](https://tatoeba.org/sentences/show/400933) e4zh1nmcz, [#9147404](https://tatoeba.org/sentences/show/9147404) bunbuku, [#227762](https://tatoeba.org/sentences/show/227762) bunbuku, [#417004](https://tatoeba.org/sentences/show/417004) bunbuku, [#9519739](https://tatoeba.org/sentences/show/9519739) small_snow, [#10191349](https://tatoeba.org/sentences/show/10191349) bunbuku, [#10580719](https://tatoeba.org/sentences/show/10580719) bunbuku, [#941192](https://tatoeba.org/sentences/show/941192) bunbuku, [#195390](https://tatoeba.org/sentences/show/195390) bunbuku, [#9943125](https://tatoeba.org/sentences/show/9943125) small_snow, [#226989](https://tatoeba.org/sentences/show/226989) bunbuku, [#10911484](https://tatoeba.org/sentences/show/10911484) small_snow, [#9997290](https://tatoeba.org/sentences/show/9997290) small_snow, [#1848747](https://tatoeba.org/sentences/show/1848747) bunbuku, [#416304](https://tatoeba.org/sentences/show/416304) bunbuku, [#200771](https://tatoeba.org/sentences/show/200771) tommy_san
- `ja-phrases-small-talk`: [#229331](https://tatoeba.org/sentences/show/229331) bunbuku, [#171591](https://tatoeba.org/sentences/show/171591) tommy_san, [#11041816](https://tatoeba.org/sentences/show/11041816) small_snow, [#8405174](https://tatoeba.org/sentences/show/8405174) Ninja, [#189750](https://tatoeba.org/sentences/show/189750) small_snow, [#3716099](https://tatoeba.org/sentences/show/3716099) tommy_san, [#3859916](https://tatoeba.org/sentences/show/3859916) tommy_san, [#3488321](https://tatoeba.org/sentences/show/3488321) arnab, [#10617601](https://tatoeba.org/sentences/show/10617601) small_snow, [#140420](https://tatoeba.org/sentences/show/140420) bunbuku, [#3662083](https://tatoeba.org/sentences/show/3662083) tommy_san, [#1088634](https://tatoeba.org/sentences/show/1088634) bunbuku, [#148119](https://tatoeba.org/sentences/show/148119) bunbuku, [#11563473](https://tatoeba.org/sentences/show/11563473) small_snow, [#3247983](https://tatoeba.org/sentences/show/3247983) tommy_san, [#192903](https://tatoeba.org/sentences/show/192903) bunbuku, [#9146022](https://tatoeba.org/sentences/show/9146022) bunbuku, [#148465](https://tatoeba.org/sentences/show/148465) tommy__san, [#3574912](https://tatoeba.org/sentences/show/3574912) tommy_san, [#3662072](https://tatoeba.org/sentences/show/3662072) tommy_san, [#3190698](https://tatoeba.org/sentences/show/3190698) tommy__san, [#200923](https://tatoeba.org/sentences/show/200923) bunbuku, [#122452](https://tatoeba.org/sentences/show/122452) arnab, [#122503](https://tatoeba.org/sentences/show/122503) small_snow, [#122364](https://tatoeba.org/sentences/show/122364) bunbuku, [#5955920](https://tatoeba.org/sentences/show/5955920) tatoebane, [#2744751](https://tatoeba.org/sentences/show/2744751) tommy_san, [#3878054](https://tatoeba.org/sentences/show/3878054) tommy_san, [#4751](https://tatoeba.org/sentences/show/4751) bunbuku, [#3488338](https://tatoeba.org/sentences/show/3488338) arnab
- `ja-phrases-restaurant`: [#180414](https://tatoeba.org/sentences/show/180414) bunbuku, [#220894](https://tatoeba.org/sentences/show/220894) small_snow, [#194613](https://tatoeba.org/sentences/show/194613) small_snow, [#3549484](https://tatoeba.org/sentences/show/3549484) tommy_san, [#217064](https://tatoeba.org/sentences/show/217064) tommy_san, [#227687](https://tatoeba.org/sentences/show/227687) bunbuku, [#8583430](https://tatoeba.org/sentences/show/8583430) bunbuku, [#11945670](https://tatoeba.org/sentences/show/11945670) small_snow, [#3466602](https://tatoeba.org/sentences/show/3466602) tommy_san, [#182129](https://tatoeba.org/sentences/show/182129) bunbuku, [#8886173](https://tatoeba.org/sentences/show/8886173) small_snow, [#227004](https://tatoeba.org/sentences/show/227004) bunbuku, [#184053](https://tatoeba.org/sentences/show/184053) bunbuku, [#11045051](https://tatoeba.org/sentences/show/11045051) KK_kaku_, [#11058387](https://tatoeba.org/sentences/show/11058387) small_snow, [#11548108](https://tatoeba.org/sentences/show/11548108) small_snow, [#12281317](https://tatoeba.org/sentences/show/12281317) small_snow, [#10100070](https://tatoeba.org/sentences/show/10100070) small_snow
- `ja-phrases-shopping`: [#2413229](https://tatoeba.org/sentences/show/2413229) tommy_san, [#2852684](https://tatoeba.org/sentences/show/2852684) tommy_san, [#151007](https://tatoeba.org/sentences/show/151007) bunbuku, [#145955](https://tatoeba.org/sentences/show/145955) bunbuku, [#892996](https://tatoeba.org/sentences/show/892996) bunbuku, [#13479050](https://tatoeba.org/sentences/show/13479050) Gardenia, [#8576543](https://tatoeba.org/sentences/show/8576543) small_snow, [#146823](https://tatoeba.org/sentences/show/146823) bunbuku, [#192354](https://tatoeba.org/sentences/show/192354) bunbuku, [#227370](https://tatoeba.org/sentences/show/227370) bunbuku, [#11013731](https://tatoeba.org/sentences/show/11013731) KK_kaku_, [#226474](https://tatoeba.org/sentences/show/226474) small_snow, [#1222750](https://tatoeba.org/sentences/show/1222750) bunbuku, [#10647274](https://tatoeba.org/sentences/show/10647274) small_snow, [#196916](https://tatoeba.org/sentences/show/196916) small_snow, [#3492798](https://tatoeba.org/sentences/show/3492798) arnab, [#3335510](https://tatoeba.org/sentences/show/3335510) tommy_san, [#3572593](https://tatoeba.org/sentences/show/3572593) tommy_san, [#3552893](https://tatoeba.org/sentences/show/3552893) tommy_san, [#11609989](https://tatoeba.org/sentences/show/11609989) small_snow
- `ja-phrases-transport`: [#188894](https://tatoeba.org/sentences/show/188894) bunbuku, [#9073662](https://tatoeba.org/sentences/show/9073662) small_snow, [#3488083](https://tatoeba.org/sentences/show/3488083) arnab, [#83222](https://tatoeba.org/sentences/show/83222) bunbuku, [#4769881](https://tatoeba.org/sentences/show/4769881) tommy_san, [#220297](https://tatoeba.org/sentences/show/220297) KK_kaku_, [#123603](https://tatoeba.org/sentences/show/123603) arnab, [#2533670](https://tatoeba.org/sentences/show/2533670) bunbuku, [#146179](https://tatoeba.org/sentences/show/146179) bunbuku, [#3147214](https://tatoeba.org/sentences/show/3147214) tommy_san, [#150316](https://tatoeba.org/sentences/show/150316) small_snow, [#2869237](https://tatoeba.org/sentences/show/2869237) tommy_san, [#223370](https://tatoeba.org/sentences/show/223370) bunbuku, [#198059](https://tatoeba.org/sentences/show/198059) bunbuku, [#11070984](https://tatoeba.org/sentences/show/11070984) small_snow, [#3114578](https://tatoeba.org/sentences/show/3114578) tommy_san, [#12332891](https://tatoeba.org/sentences/show/12332891) small_snow, [#224556](https://tatoeba.org/sentences/show/224556) small_snow, [#203728](https://tatoeba.org/sentences/show/203728) arnab, [#147989](https://tatoeba.org/sentences/show/147989) bunbuku, [#11041838](https://tatoeba.org/sentences/show/11041838) small_snow, [#3623504](https://tatoeba.org/sentences/show/3623504) tommy_san, [#3059415](https://tatoeba.org/sentences/show/3059415) tommy_san, [#3703788](https://tatoeba.org/sentences/show/3703788) tommy_san, [#126714](https://tatoeba.org/sentences/show/126714) tommy_san
- `ja-phrases-hotel`: [#203004](https://tatoeba.org/sentences/show/203004) small_snow, [#11640023](https://tatoeba.org/sentences/show/11640023) small_snow, [#10984988](https://tatoeba.org/sentences/show/10984988) small_snow, [#8726938](https://tatoeba.org/sentences/show/8726938) bunbuku, [#10650776](https://tatoeba.org/sentences/show/10650776) small_snow, [#203009](https://tatoeba.org/sentences/show/203009) bunbuku, [#11065678](https://tatoeba.org/sentences/show/11065678) small_snow, [#11637481](https://tatoeba.org/sentences/show/11637481) small_snow, [#11682923](https://tatoeba.org/sentences/show/11682923) small_snow, [#217611](https://tatoeba.org/sentences/show/217611) bunbuku, [#3134885](https://tatoeba.org/sentences/show/3134885) tommy_san, [#2666710](https://tatoeba.org/sentences/show/2666710) tommy_san, [#10647172](https://tatoeba.org/sentences/show/10647172) small_snow, [#167112](https://tatoeba.org/sentences/show/167112) small_snow, [#9046236](https://tatoeba.org/sentences/show/9046236) bunbuku, [#228083](https://tatoeba.org/sentences/show/228083) small_snow, [#3886922](https://tatoeba.org/sentences/show/3886922) tommy_san, [#9145780](https://tatoeba.org/sentences/show/9145780) bunbuku, [#11637517](https://tatoeba.org/sentences/show/11637517) small_snow, [#4751190](https://tatoeba.org/sentences/show/4751190) tommy_san, [#2772835](https://tatoeba.org/sentences/show/2772835) tommy_san, [#4445365](https://tatoeba.org/sentences/show/4445365) tommy_san
- `ja-phrases-work`: [#214187](https://tatoeba.org/sentences/show/214187) bunbuku, [#1063557](https://tatoeba.org/sentences/show/1063557) bunbuku, [#226997](https://tatoeba.org/sentences/show/226997) bunbuku, [#146454](https://tatoeba.org/sentences/show/146454) small_snow, [#3495037](https://tatoeba.org/sentences/show/3495037) arnab, [#202862](https://tatoeba.org/sentences/show/202862) bunbuku, [#11505779](https://tatoeba.org/sentences/show/11505779) small_snow, [#11819668](https://tatoeba.org/sentences/show/11819668) small_snow, [#11140910](https://tatoeba.org/sentences/show/11140910) bunbuku, [#10918592](https://tatoeba.org/sentences/show/10918592) small_snow, [#11306559](https://tatoeba.org/sentences/show/11306559) small_snow, [#226818](https://tatoeba.org/sentences/show/226818) bunbuku, [#3570419](https://tatoeba.org/sentences/show/3570419) tommy_san, [#11559581](https://tatoeba.org/sentences/show/11559581) small_snow, [#12022953](https://tatoeba.org/sentences/show/12022953) small_snow, [#10792724](https://tatoeba.org/sentences/show/10792724) small_snow, [#9042327](https://tatoeba.org/sentences/show/9042327) small_snow, [#3528782](https://tatoeba.org/sentences/show/3528782) tommy_san, [#4449298](https://tatoeba.org/sentences/show/4449298) amuzak1119, [#11235027](https://tatoeba.org/sentences/show/11235027) bunbuku, [#2858265](https://tatoeba.org/sentences/show/2858265) tommy_san
- `ja-phrases-school`: [#2278888](https://tatoeba.org/sentences/show/2278888) tommy_san, [#194303](https://tatoeba.org/sentences/show/194303) bunbuku, [#5109](https://tatoeba.org/sentences/show/5109) bunbuku, [#201705](https://tatoeba.org/sentences/show/201705) tommy_san, [#2519008](https://tatoeba.org/sentences/show/2519008) tommy_san, [#126710](https://tatoeba.org/sentences/show/126710) small_snow, [#10899752](https://tatoeba.org/sentences/show/10899752) small_snow, [#11243007](https://tatoeba.org/sentences/show/11243007) small_snow, [#10954030](https://tatoeba.org/sentences/show/10954030) small_snow, [#4260182](https://tatoeba.org/sentences/show/4260182) tommy_san, [#3241575](https://tatoeba.org/sentences/show/3241575) tommy_san, [#12164770](https://tatoeba.org/sentences/show/12164770) small_snow, [#886078](https://tatoeba.org/sentences/show/886078) bunbuku, [#4593695](https://tatoeba.org/sentences/show/4593695) tommy_san, [#3559188](https://tatoeba.org/sentences/show/3559188) tommy_san, [#151057](https://tatoeba.org/sentences/show/151057) KK_kaku_, [#9271154](https://tatoeba.org/sentences/show/9271154) small_snow, [#3642246](https://tatoeba.org/sentences/show/3642246) tommy_san, [#9399075](https://tatoeba.org/sentences/show/9399075) small_snow, [#11877731](https://tatoeba.org/sentences/show/11877731) small_snow, [#141421](https://tatoeba.org/sentences/show/141421) tommy_san, [#3615494](https://tatoeba.org/sentences/show/3615494) tommy_san
- `ja-phrases-health`: [#3590724](https://tatoeba.org/sentences/show/3590724) tommy_san, [#10008425](https://tatoeba.org/sentences/show/10008425) Sim5634, [#173826](https://tatoeba.org/sentences/show/173826) tommy_san, [#183996](https://tatoeba.org/sentences/show/183996) arnab, [#11029628](https://tatoeba.org/sentences/show/11029628) small_snow, [#3554821](https://tatoeba.org/sentences/show/3554821) tommy__san, [#9124673](https://tatoeba.org/sentences/show/9124673) bunbuku, [#85506](https://tatoeba.org/sentences/show/85506) bunbuku, [#1836391](https://tatoeba.org/sentences/show/1836391) small_snow, [#11173232](https://tatoeba.org/sentences/show/11173232) small_snow, [#138002](https://tatoeba.org/sentences/show/138002) bunbuku, [#10725058](https://tatoeba.org/sentences/show/10725058) bunbuku, [#10159575](https://tatoeba.org/sentences/show/10159575) small_snow, [#4001492](https://tatoeba.org/sentences/show/4001492) tommy_san, [#3023116](https://tatoeba.org/sentences/show/3023116) tommy_san, [#10473145](https://tatoeba.org/sentences/show/10473145) small_snow, [#11258050](https://tatoeba.org/sentences/show/11258050) sh5555, [#10764041](https://tatoeba.org/sentences/show/10764041) small_snow, [#10483212](https://tatoeba.org/sentences/show/10483212) small_snow, [#3567548](https://tatoeba.org/sentences/show/3567548) tommy_san, [#11508401](https://tatoeba.org/sentences/show/11508401) small_snow
- `ja-phrases-phone`: [#9594385](https://tatoeba.org/sentences/show/9594385) small_snow, [#10021481](https://tatoeba.org/sentences/show/10021481) small_snow, [#234316](https://tatoeba.org/sentences/show/234316) bunbuku, [#8424881](https://tatoeba.org/sentences/show/8424881) small_snow, [#124931](https://tatoeba.org/sentences/show/124931) bunbuku, [#214190](https://tatoeba.org/sentences/show/214190) small_snow, [#4272221](https://tatoeba.org/sentences/show/4272221) Hashimoto, [#8901912](https://tatoeba.org/sentences/show/8901912) tommy_san, [#11029495](https://tatoeba.org/sentences/show/11029495) small_snow, [#11200497](https://tatoeba.org/sentences/show/11200497) bunbuku, [#10367615](https://tatoeba.org/sentences/show/10367615) small_snow, [#8537273](https://tatoeba.org/sentences/show/8537273) small_snow, [#11900875](https://tatoeba.org/sentences/show/11900875) small_snow, [#12954886](https://tatoeba.org/sentences/show/12954886) small_snow, [#12148307](https://tatoeba.org/sentences/show/12148307) small_snow, [#3393828](https://tatoeba.org/sentences/show/3393828) tommy_san, [#11045213](https://tatoeba.org/sentences/show/11045213) KK_kaku_, [#3224399](https://tatoeba.org/sentences/show/3224399) tommy_san, [#3456783](https://tatoeba.org/sentences/show/3456783) tommy_san, [#3024534](https://tatoeba.org/sentences/show/3024534) tommy_san, [#3062456](https://tatoeba.org/sentences/show/3062456) tommy_san, [#12300725](https://tatoeba.org/sentences/show/12300725) small_snow, [#3652304](https://tatoeba.org/sentences/show/3652304) tommy_san, [#10587786](https://tatoeba.org/sentences/show/10587786) Sonata
- `ja-phrases-emergency`: [#2529055](https://tatoeba.org/sentences/show/2529055) tommy_san, [#182412](https://tatoeba.org/sentences/show/182412) tommy_san, [#2838455](https://tatoeba.org/sentences/show/2838455) tommy_san, [#183597](https://tatoeba.org/sentences/show/183597) bunbuku, [#5955873](https://tatoeba.org/sentences/show/5955873) tatoebane, [#10682289](https://tatoeba.org/sentences/show/10682289) small_snow, [#188169](https://tatoeba.org/sentences/show/188169) bunbuku, [#10701773](https://tatoeba.org/sentences/show/10701773) small_snow, [#10574443](https://tatoeba.org/sentences/show/10574443) small_snow, [#197966](https://tatoeba.org/sentences/show/197966) tommy_san, [#1180855](https://tatoeba.org/sentences/show/1180855) bunbuku, [#1266928](https://tatoeba.org/sentences/show/1266928) bunbuku, [#10901607](https://tatoeba.org/sentences/show/10901607) small_snow, [#227358](https://tatoeba.org/sentences/show/227358) arnab, [#8974455](https://tatoeba.org/sentences/show/8974455) bunbuku, [#9161932](https://tatoeba.org/sentences/show/9161932) bunbuku
- `ja-phrases-feelings`: [#1532832](https://tatoeba.org/sentences/show/1532832) bunbuku, [#9559301](https://tatoeba.org/sentences/show/9559301) Sim5634, [#408295](https://tatoeba.org/sentences/show/408295) bunbuku, [#408301](https://tatoeba.org/sentences/show/408301) bunbuku, [#10626981](https://tatoeba.org/sentences/show/10626981) nihonjin, [#183275](https://tatoeba.org/sentences/show/183275) small_snow, [#1282984](https://tatoeba.org/sentences/show/1282984) bunbuku, [#10984256](https://tatoeba.org/sentences/show/10984256) small_snow, [#5650413](https://tatoeba.org/sentences/show/5650413) tommy_san, [#10090485](https://tatoeba.org/sentences/show/10090485) small_snow, [#3158402](https://tatoeba.org/sentences/show/3158402) tommy_san, [#10355885](https://tatoeba.org/sentences/show/10355885) small_snow, [#4478292](https://tatoeba.org/sentences/show/4478292) tommy_san, [#4478301](https://tatoeba.org/sentences/show/4478301) tommy_san, [#4478293](https://tatoeba.org/sentences/show/4478293) tommy_san, [#10657701](https://tatoeba.org/sentences/show/10657701) small_snow, [#10117512](https://tatoeba.org/sentences/show/10117512) bunbuku, [#2261687](https://tatoeba.org/sentences/show/2261687) verbum, [#11049529](https://tatoeba.org/sentences/show/11049529) small_snow, [#9775149](https://tatoeba.org/sentences/show/9775149) small_snow, [#11256165](https://tatoeba.org/sentences/show/11256165) sh5555, [#4591666](https://tatoeba.org/sentences/show/4591666) wat, [#3621733](https://tatoeba.org/sentences/show/3621733) arnab, [#10904982](https://tatoeba.org/sentences/show/10904982) small_snow, [#8604660](https://tatoeba.org/sentences/show/8604660) small_snow, [#2615036](https://tatoeba.org/sentences/show/2615036) tommy_san, [#891336](https://tatoeba.org/sentences/show/891336) bunbuku, [#126817](https://tatoeba.org/sentences/show/126817) bunbuku, [#11029766](https://tatoeba.org/sentences/show/11029766) small_snow
- `zh-phrases-greetings`: [#4857568](https://tatoeba.org/sentences/show/4857568) musclegirlxyp, [#13598193](https://tatoeba.org/sentences/show/13598193) LeviHighway, [#6559016](https://tatoeba.org/sentences/show/6559016) xjjAstrus, [#2030795](https://tatoeba.org/sentences/show/2030795) sadhen, [#10966735](https://tatoeba.org/sentences/show/10966735) xjjAstrus, [#9954864](https://tatoeba.org/sentences/show/9954864) GlossaMatik, [#710777](https://tatoeba.org/sentences/show/710777) Yashanti, [#10966808](https://tatoeba.org/sentences/show/10966808) xjjAstrus, [#1441829](https://tatoeba.org/sentences/show/1441829) egg0073, [#466655](https://tatoeba.org/sentences/show/466655) GlossaMatik, [#4463431](https://tatoeba.org/sentences/show/4463431) maple, [#9992000](https://tatoeba.org/sentences/show/9992000) GlossaMatik, [#1762971](https://tatoeba.org/sentences/show/1762971) sadhen, [#1878357](https://tatoeba.org/sentences/show/1878357) sadhen, [#10966828](https://tatoeba.org/sentences/show/10966828) xjjAstrus, [#435215](https://tatoeba.org/sentences/show/435215) GlossaMatik, [#4835855](https://tatoeba.org/sentences/show/4835855) sadhen, [#3338897](https://tatoeba.org/sentences/show/3338897) sadhen
- `zh-phrases-small-talk`: [#2358130](https://tatoeba.org/sentences/show/2358130) iMaple, [#507343](https://tatoeba.org/sentences/show/507343) GlossaMatik, [#3378243](https://tatoeba.org/sentences/show/3378243) GlossaMatik, [#3377988](https://tatoeba.org/sentences/show/3377988) GlossaMatik, [#776420](https://tatoeba.org/sentences/show/776420) GlossaMatik, [#10155004](https://tatoeba.org/sentences/show/10155004) GlossaMatik, [#710694](https://tatoeba.org/sentences/show/710694) gumblex, [#2040311](https://tatoeba.org/sentences/show/2040311) sadhen, [#9974965](https://tatoeba.org/sentences/show/9974965) GlossaMatik, [#10265782](https://tatoeba.org/sentences/show/10265782) GlossaMatik, [#4649770](https://tatoeba.org/sentences/show/4649770) Yashanti, [#10275184](https://tatoeba.org/sentences/show/10275184) miaojiandao, [#478790](https://tatoeba.org/sentences/show/478790) biglion
- `zh-phrases-restaurant`: [#419685](https://tatoeba.org/sentences/show/419685) GlossaMatik, [#5611611](https://tatoeba.org/sentences/show/5611611) verdastelo9604, [#470019](https://tatoeba.org/sentences/show/470019) GlossaMatik, [#2302310](https://tatoeba.org/sentences/show/2302310) egg0073, [#419672](https://tatoeba.org/sentences/show/419672) GlossaMatik, [#4760043](https://tatoeba.org/sentences/show/4760043) ryanwoo, [#2116863](https://tatoeba.org/sentences/show/2116863) sadhen, [#12687076](https://tatoeba.org/sentences/show/12687076) soueihin, [#14067734](https://tatoeba.org/sentences/show/14067734) jan_OkulaJu, [#5102215](https://tatoeba.org/sentences/show/5102215) mirrorvan
- `zh-phrases-shopping`: [#10052325](https://tatoeba.org/sentences/show/10052325) GlossaMatik, [#4761386](https://tatoeba.org/sentences/show/4761386) billt_estates, [#10054219](https://tatoeba.org/sentences/show/10054219) slo_oth, [#8749676](https://tatoeba.org/sentences/show/8749676) crescat, [#7798822](https://tatoeba.org/sentences/show/7798822) jiangche, [#11702399](https://tatoeba.org/sentences/show/11702399) Jokubas, [#10109526](https://tatoeba.org/sentences/show/10109526) ColawithIce, [#1785977](https://tatoeba.org/sentences/show/1785977) sadhen, [#12686033](https://tatoeba.org/sentences/show/12686033) soueihin, [#8789683](https://tatoeba.org/sentences/show/8789683) crescat, [#8656919](https://tatoeba.org/sentences/show/8656919) crescat, [#9838191](https://tatoeba.org/sentences/show/9838191) morningstar
- `zh-phrases-transport`: [#6559053](https://tatoeba.org/sentences/show/6559053) xjjAstrus, [#3365867](https://tatoeba.org/sentences/show/3365867) hzy980512, [#398388](https://tatoeba.org/sentences/show/398388) GlossaMatik, [#5102335](https://tatoeba.org/sentences/show/5102335) mirrorvan, [#4900904](https://tatoeba.org/sentences/show/4900904) musclegirlxyp, [#425131](https://tatoeba.org/sentences/show/425131) GlossaMatik, [#397172](https://tatoeba.org/sentences/show/397172) GlossaMatik, [#6822548](https://tatoeba.org/sentences/show/6822548) basilhan, [#9594927](https://tatoeba.org/sentences/show/9594927) jin1, [#8120972](https://tatoeba.org/sentences/show/8120972) GlossaMatik, [#399588](https://tatoeba.org/sentences/show/399588) GlossaMatik, [#3493093](https://tatoeba.org/sentences/show/3493093) GlossaMatik, [#7950268](https://tatoeba.org/sentences/show/7950268) GlossaMatik
- `zh-phrases-hotel`: [#395562](https://tatoeba.org/sentences/show/395562) GlossaMatik, [#7773214](https://tatoeba.org/sentences/show/7773214) jiangche, [#8831906](https://tatoeba.org/sentences/show/8831906) crescat, [#8777616](https://tatoeba.org/sentences/show/8777616) crescat, [#8887773](https://tatoeba.org/sentences/show/8887773) morningstar, [#5967319](https://tatoeba.org/sentences/show/5967319) verdastelo9604, [#4952817](https://tatoeba.org/sentences/show/4952817) murr, [#6559029](https://tatoeba.org/sentences/show/6559029) xjjAstrus
- `zh-phrases-work`: [#13549383](https://tatoeba.org/sentences/show/13549383) LeviHighway, [#7772049](https://tatoeba.org/sentences/show/7772049) jiangche, [#710768](https://tatoeba.org/sentences/show/710768) Yashanti, [#14004668](https://tatoeba.org/sentences/show/14004668) jan_OkulaJu, [#419800](https://tatoeba.org/sentences/show/419800) GlossaMatik, [#13938564](https://tatoeba.org/sentences/show/13938564) jan_OkulaJu, [#10043970](https://tatoeba.org/sentences/show/10043970) GlossaMatik, [#9962407](https://tatoeba.org/sentences/show/9962407) GlossaMatik, [#4261676](https://tatoeba.org/sentences/show/4261676) egg0073, [#9012174](https://tatoeba.org/sentences/show/9012174) jacintoo, [#9961343](https://tatoeba.org/sentences/show/9961343) GlossaMatik, [#11702402](https://tatoeba.org/sentences/show/11702402) Jokubas
- `zh-phrases-school`: [#1783789](https://tatoeba.org/sentences/show/1783789) sadhen, [#2032276](https://tatoeba.org/sentences/show/2032276) ydcok, [#1786018](https://tatoeba.org/sentences/show/1786018) sadhen, [#13910269](https://tatoeba.org/sentences/show/13910269) jan_OkulaJu, [#8685550](https://tatoeba.org/sentences/show/8685550) crescat, [#1750551](https://tatoeba.org/sentences/show/1750551) sadhen, [#10024477](https://tatoeba.org/sentences/show/10024477) GlossaMatik, [#4265057](https://tatoeba.org/sentences/show/4265057) notabene, [#13744215](https://tatoeba.org/sentences/show/13744215) fup6m3vj0, [#4885094](https://tatoeba.org/sentences/show/4885094) musclegirlxyp, [#3338900](https://tatoeba.org/sentences/show/3338900) sadhen, [#13667864](https://tatoeba.org/sentences/show/13667864) LeviHighway, [#1749219](https://tatoeba.org/sentences/show/1749219) sadhen, [#9990149](https://tatoeba.org/sentences/show/9990149) GlossaMatik, [#14015161](https://tatoeba.org/sentences/show/14015161) jan_OkulaJu
- `zh-phrases-health`: [#396056](https://tatoeba.org/sentences/show/396056) GlossaMatik, [#488753](https://tatoeba.org/sentences/show/488753) GlossaMatik, [#14037696](https://tatoeba.org/sentences/show/14037696) jan_OkulaJu, [#433940](https://tatoeba.org/sentences/show/433940) GlossaMatik, [#8626613](https://tatoeba.org/sentences/show/8626613) xjjAstrus, [#13914750](https://tatoeba.org/sentences/show/13914750) jan_OkulaJu, [#4878943](https://tatoeba.org/sentences/show/4878943) musclegirlxyp, [#4844988](https://tatoeba.org/sentences/show/4844988) pig8322, [#395058](https://tatoeba.org/sentences/show/395058) GlossaMatik, [#5842654](https://tatoeba.org/sentences/show/5842654) verdastelo9604, [#10540451](https://tatoeba.org/sentences/show/10540451) GlossaMatik, [#4887549](https://tatoeba.org/sentences/show/4887549) musclegirlxyp, [#826542](https://tatoeba.org/sentences/show/826542) jessie0422, [#9958174](https://tatoeba.org/sentences/show/9958174) GlossaMatik
- `zh-phrases-phone`: [#13943170](https://tatoeba.org/sentences/show/13943170) jan_OkulaJu, [#10966785](https://tatoeba.org/sentences/show/10966785) xjjAstrus, [#4104698](https://tatoeba.org/sentences/show/4104698) maple, [#10695961](https://tatoeba.org/sentences/show/10695961) GlossaMatik, [#8734985](https://tatoeba.org/sentences/show/8734985) crescat, [#8501492](https://tatoeba.org/sentences/show/8501492) maxine, [#14067864](https://tatoeba.org/sentences/show/14067864) CanonNi, [#13936933](https://tatoeba.org/sentences/show/13936933) jan_OkulaJu, [#1672198](https://tatoeba.org/sentences/show/1672198) sadhen, [#13914972](https://tatoeba.org/sentences/show/13914972) jan_OkulaJu, [#12520688](https://tatoeba.org/sentences/show/12520688) panxiao81, [#733154](https://tatoeba.org/sentences/show/733154) GlossaMatik, [#9490148](https://tatoeba.org/sentences/show/9490148) jin1
- `zh-phrases-emergency`: [#12278478](https://tatoeba.org/sentences/show/12278478) FishlandicFishy, [#11207038](https://tatoeba.org/sentences/show/11207038) klzlueylx, [#1205903](https://tatoeba.org/sentences/show/1205903) cienias, [#4638683](https://tatoeba.org/sentences/show/4638683) yuiyu, [#7772052](https://tatoeba.org/sentences/show/7772052) jiangche, [#5096869](https://tatoeba.org/sentences/show/5096869) mirrorvan, [#10618353](https://tatoeba.org/sentences/show/10618353) hhyyhh4547, [#2028019](https://tatoeba.org/sentences/show/2028019) ydcok, [#5630412](https://tatoeba.org/sentences/show/5630412) verdastelo9604, [#2143971](https://tatoeba.org/sentences/show/2143971) ydcok, [#9970755](https://tatoeba.org/sentences/show/9970755) GlossaMatik, [#10011673](https://tatoeba.org/sentences/show/10011673) GlossaMatik, [#10635236](https://tatoeba.org/sentences/show/10635236) gumblex
- `zh-phrases-feelings`: [#9992034](https://tatoeba.org/sentences/show/9992034) GlossaMatik, [#551441](https://tatoeba.org/sentences/show/551441) GlossaMatik, [#13901017](https://tatoeba.org/sentences/show/13901017) jan_OkulaJu, [#8780278](https://tatoeba.org/sentences/show/8780278) crescat, [#707183](https://tatoeba.org/sentences/show/707183) Yashanti, [#3378156](https://tatoeba.org/sentences/show/3378156) GlossaMatik, [#4881640](https://tatoeba.org/sentences/show/4881640) musclegirlxyp, [#4835868](https://tatoeba.org/sentences/show/4835868) sadhen, [#10157032](https://tatoeba.org/sentences/show/10157032) yeyue, [#10981515](https://tatoeba.org/sentences/show/10981515) Elaineeeeee, [#9992054](https://tatoeba.org/sentences/show/9992054) GlossaMatik, [#13111574](https://tatoeba.org/sentences/show/13111574) LeviHighway, [#3378044](https://tatoeba.org/sentences/show/3378044) GlossaMatik, [#10028154](https://tatoeba.org/sentences/show/10028154) GlossaMatik, [#12278485](https://tatoeba.org/sentences/show/12278485) FishlandicFishy, [#5102293](https://tatoeba.org/sentences/show/5102293) mirrorvan, [#9964362](https://tatoeba.org/sentences/show/9964362) GlossaMatik, [#5911701](https://tatoeba.org/sentences/show/5911701) verdastelo9604, [#14038300](https://tatoeba.org/sentences/show/14038300) jan_OkulaJu, [#2347835](https://tatoeba.org/sentences/show/2347835) GlossaMatik, [#8647815](https://tatoeba.org/sentences/show/8647815) crescat, [#10024445](https://tatoeba.org/sentences/show/10024445) GlossaMatik

<!-- phrase-credits:end -->

</details>

## Licensing summary

Lists built from CC BY-SA sources (all frequency bands, the HSK lists via
CC-CEDICT, and the ordering of the JLPT lists) are redistributed under
CC BY-SA 4.0 with the attribution above. The example sentences from Tatoeba
and the Tatoeba phrases in the phrase decks are CC BY 2.0 FR, attributed above. Changes made: filtering, lemma
folding, truncation and reordering.
