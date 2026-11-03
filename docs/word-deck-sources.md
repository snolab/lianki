# Exam word decks: sources and licences

Owner, 2026-11-03 14:57 JST, /words: "单词卡组帮我加入各种常见的，像是四六级词表、GRE、托福什么的",
widened to "各种语言考试的词表". This file records, for every candidate exam deck,
where a word list could come from, its licence, what we take, and the
attribution we show. Only decks with a source whose licence allows
redistribution in a paid app (Lianki sells Pro passes) are shipped. So
"non-commercial" (NC) licences and "all rights reserved" publications are
excluded, even for a bare list of headwords.

Build: `scripts/words/build-exam-decks.ts` (the download commands are in its
header). Per-list attribution is in each list's `source` and `license` fields,
shown under the list in the /words "Add a list" picker. The full notes are in
[public/words/SOURCES.md](../public/words/SOURCES.md), "English exam decks".
The picker groups them by language, then exam ("Exam word lists" → exam name →
levels). JLPT and HSK, which were already shipped, now appear there too.

## Shipped

All English decks have **Chinese meanings** (the owner's ask), an IPA reading
where Wiktionary has one (about 94% of words) and, where one is found, one example sentence. They are ordered by frequency,
most common first. Each part of a card comes from one place:

| Part of the card                          | Source                                                                                                                                                                       | Licence                                                    | Attribution shown                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Which words an exam deck holds (中考 … GRE) | [ECDICT](https://github.com/skywind3000/ECDICT) `ecdict.csv`, column `tag` only                                                                                               | MIT ([LICENSE](https://github.com/skywind3000/ECDICT/blob/master/LICENSE), © 2025 Linwei) | "Word list and frequency order: the exam tag of ECDICT (skywind3000/ECDICT)"; MIT notice in public/words/SOURCES.md |
| Frequency order, word forms               | ECDICT columns `frq` (COCA rank), `bnc` (BNC rank) and `exchange` (inflections, the lemma of a plural)                                                                       | MIT                                                        | as above                                                                                                            |
| Which words the NGSL/TSL/NAWL decks hold, and their order | [NGSL 1.2](https://www.newgeneralservicelist.com/new-general-service-list), [NAWL 1.2](https://www.newgeneralservicelist.com/new-academic-word-list), [TSL 1.2](https://www.newgeneralservicelist.com/toeic-service-list), `*_12_stats.csv` | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | NGSL and NAWL: "by Charles Browne, Brent Culligan and Joseph Phillips"; TSL: "by Charles Browne and Brent Culligan" |
| Chinese meaning                           | English Wiktionary's translation tables into Mandarin, via the [kaikki.org](https://kaikki.org/dictionary/English/) extract (wiktextract, Tatu Ylonen)                       | CC BY-SA 4.0 (and GFDL)                                    | "Chinese meanings and IPA: English Wiktionary (en.wiktionary.org) contributors, via kaikki.org"                     |
| Chinese meaning, when Wiktionary has none (4,392 words, about 30%) | Written for Lianki in `scripts/words/exam-glosses.tsv`, from the word's English Wiktionary definitions, which the builder writes next to each word in `need-glosses.tsv`. They were drafted with an LLM (Claude) under fixed rules: dictionary-style equivalents, at most 3 senses, no rare senses. | CC BY-SA 4.0, as an adaptation of the Wiktionary definitions | "meanings Wiktionary has no Chinese for written for Lianki from its definitions"                                    |
| IPA                                       | English Wiktionary pronunciation (British when given, as Chinese exam books use)                                                                                            | CC BY-SA 4.0                                               | as Chinese meaning                                                                                                  |
| Example sentence                          | The sentence the English frequency list (`en-freq-*`) gives the word, else the shortest [Tatoeba](https://tatoeba.org) English sentence with the word or a form             | CC BY 2.0 FR (Tatoeba); CC BY-SA 4.0 (Wiktionary examples) | Each card carries `exSrc` (`tatoeba:<id>` or `wiktionary`) and `exBy` (the Tatoeba author)                          |

ECDICT's Chinese `translation`, `phonetic`, `definition`, `oxford` and
`collins` columns are **not** used (see the licence reasoning below).

| Deck (id)                                 | Words | Word list                                     | Deck licence |
| ----------------------------------------- | ----: | --------------------------------------------- | ------------ |
| 中考 Zhongkao (`en-exam-zk`)               | 1,538 | ECDICT tag `zk`                            | CC BY-SA 4.0 (Wiktionary content); word list MIT |
| 高考 Gaokao (`en-exam-gk`)                 | 3,490 | ECDICT tag `gk`                            | same |
| CET-4 四级 (`en-exam-cet4`)                | 3,783 | ECDICT tag `cet4`. Very basic words (the, run, get) carry no `cet4` tag, so this is the CET-4 vocabulary beyond them. | same |
| CET-6 六级 (`en-exam-cet6`)                | 1,932 | ECDICT tag `cet6` minus words tagged `cet4`. It holds only what CET-6 adds, like the HSK levels, so a learner with both decks never sees a word twice. | same |
| 考研 NEEP (`en-exam-ky`)                   | 4,754 | ECDICT tag `ky`                            | same |
| IELTS (`en-exam-ielts`)                   | 4,615 | ECDICT tag `ielts`                      | same |
| TOEFL (`en-exam-toefl`)                   | 6,739 | ECDICT tag `toefl`                      | same |
| GRE (`en-exam-gre`)                       | 7,359 | ECDICT tag `gre`. Some common words (want, even, school) carry the tag for their rarer senses, and come first by frequency. | same |
| TOEIC Service List (`en-tsl`)             | 1,250 | TSL 1.2                                   | CC BY-SA 4.0 |
| NGSL core words (`en-ngsl`)               | 2,809 | NGSL 1.2                                 | CC BY-SA 4.0 |
| NAWL academic words (`en-nawl`)           | 948 | NAWL 1.2. The prefixes trans, micro, semi, multi and neo get no card. | CC BY-SA 4.0 |
| Japanese JLPT N5–N1 (`ja-jlpt-*`)         | —     | already shipped; now grouped under "JLPT" in the picker | see SOURCES.md |
| Chinese HSK 3.0 1–6, 7–9 (`zh-hsk-*`)     | —     | already shipped; now grouped under "HSK 3.0". Old HSK 2.0 levels are not added: HSK 3.0 replaced them and they would duplicate it. | see SOURCES.md |

Every deck in the table: proper names, abbreviations and an inflection whose
lemma is in the same deck ("drugs" with "drug") are left out. So are words with
no English Wiktionary entry, such as misspellings in the source ("reservior")
and place names.

### Licence reasoning for ECDICT

- ECDICT's author releases the repository, data included, under MIT. MIT
  allows commercial use and redistribution with the copyright notice. That
  notice is reproduced in public/words/SOURCES.md.
- Provenance caveat (raised by the Codex review): the README says the base
  vocabulary started from word lists found online ("一份四六级到 GRE
  包含释义的词汇表"), with phonetics collected from various sources. MIT can
  only pass on the rights its author holds. So we take **no expressive content
  from ECDICT**: no Chinese glosses, definitions or phonetics. We take only
  facts about words:
  - whether a word is tagged for an exam: a set of headwords. We re-sort it
    by frequency, which removes the source's arrangement but not its
    selection (see the next point);
  - two corpus frequency ranks;
  - inflected forms.
  Meanings, IPA and examples come from Wiktionary and Tatoeba, whose licences
  are clear.
- What is left at risk is the membership of each exam list, if the original
  compiler of a list claimed it as a compilation. Exam syllabus vocabularies
  are published by the exam bodies themselves (教育部考试中心 for CET and 考研)
  and are reproduced in every prep book. A bare alphabetical or
  frequency-sorted headword set has thin protection. If the owner wants zero
  dependency on ECDICT, the CET/考研 decks could be rebuilt from the published
  syllabus appendices, and the IELTS/TOEFL/GRE decks dropped. The NGSL, NAWL
  and TSL decks would stay.

### NGSL family

NGSL, NAWL and TSL 1.2 are each published on newgeneralservicelist.com under
"Creative Commons Attribution-ShareAlike 4.0 International", and the page adds
that "permissions beyond the scope of this license may be available". Our decks
built from them are therefore CC BY-SA 4.0 (share-alike), as their `license`
field says. Changes made: Chinese meanings, IPA and example sentences added;
Excel's TRUE/FALSE restored to true/false; prefixes dropped.

## Not shipped (no cleared source identified)

| Candidate                                    | What exists                                                                                                                                                                                                   | Why not                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAT                                          | College Board publishes no word list. GitHub "SAT words" lists are copied from prep books (Barron's, Kaplan).                                                                                                  | No list with a licence; ECDICT has no SAT tag.                                                                                                                                                                                                     |
| Oxford 3000 / 5000                           | [oxfordlearnersdictionaries.com](https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000), © Oxford University Press. GitHub copies have no licence from OUP.                                  | No licence to redistribute. ECDICT's `oxford` column replicates it, so we do not use that column.                                                                                                                                                 |
| French DELF A1–B2 / DALF / TCF / TEF         | France Éducation International publishes no vocabulary list for these exams. The CEFR-graded [FLELex](https://cental.uclouvain.be/cefrlex/flelex/download/) (UCLouvain) is CC BY-NC-SA 4.0. Beacco's *Niveau A1/A2/B1/B2 pour le français* (Didier) is a commercial book. | FLELex is NC, and Lianki is a paid app; the Beacco books are all rights reserved. Option: ask the FLELex authors (Thomas François, CENTAL) for a commercial permission. Until then the French frequency bands (`fr-freq-*`, CC BY-SA) stay the French path. |
| German Goethe-Zertifikat A1/A2/B1            | The official Wortlisten PDFs ([A1](https://www.goethe.de/pro/relaunch/prf/sw/Goethe-Zertifikat_A1_Fit1_Wortliste.pdf)) carry "© Goethe-Institut 2024" and no licence.                                      | All rights reserved. Option: ask the Goethe-Institut for permission.                                                                                                                                                                              |
| Spanish DELE                                 | Instituto Cervantes' *Plan curricular* (cvc.cervantes.es) "Nociones específicas" inventories.                                                                                                                | Instituto Cervantes copyright, no open licence found.                                                                                                                                                                                             |
| Italian CILS / CELI                          | No official word list. The CEFR-graded Kelly list for Italian is CC BY-NC-SA 2.0 ([Kelly project](https://hf.uio.no/iln/english/about/organization/text-laboratory/services/kelly.html)).                     | NC.                                                                                                                                                                                                                                                |
| Portuguese CAPLE / CELPE-Bras                | No official word list found.                                                                                                                                                                                  | Nothing to take.                                                                                                                                                                                                                                   |
| Russian TORFL (ТРКИ)                         | The "Лексический минимум" volumes (ed. Andryushina, Zlatoust, St Petersburg) are commercial books.                                                                                                             | All rights reserved. The Kelly Russian list is NC.                                                                                                                                                                                                 |
| Korean TOPIK I / II                          | TOPIK has no official word list. The National Institute of Korean Language's [한국어 학습용 어휘 목록](https://www.korean.go.kr/front_eng/down/down_02V.do?etc_seq=70) (2003; 5,965 words, grades A/B/C) is **KOGL Type 1** (공공누리 제1유형: free use, including commercial, with the source named). | **Clean: a follow-up PR** (the owner asked for English and French first). The list has no meanings, so they would come from the Korean Wiktionary data the `ko-freq` lists use. Attribution: "한국어 학습용 어휘 목록, 국립국어원 (2003), 공공누리 제1유형". |
| Japanese JLPT, Chinese HSK                   | Already shipped (see above).                                                                                                                                                                                  | Not duplicated.                                                                                                                                                                                                                                    |
| CET / 考研 official syllabus lists           | The 大学英语四六级考试大纲 and 考研英语大纲 vocabulary appendices (教育部考试中心).                                                                                                                                     | Not used directly: no file with a stated licence. The ECDICT tags cover the same exams under MIT.                                                                                                                                                 |
