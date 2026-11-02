# Introducing new words when several languages are studied together

Research note, 2026-10-31. It informs how "Study all lists together" in
`/words` should order new words and how many to bring in each day. The owner
asked for evidence from 2018 onward, with sample sizes and limitations, and
for plain statements where the evidence is thin. Every source below was
checked against Crossref or an opened page. Anything not verified is marked.

## What Lianki does today

- Each list has its own FSRS parameters (`lib/words/schedule.ts`): target
  retention 0.85, learning steps 1m/5m, and `newPerDay` 50 **per list**.
- "Study all lists" (`app/(app)/words/WordsClient.tsx`) round-robins **due**
  words across lists (`interleave`). It takes **new** words in list order:
  the first list until it runs out, then the next (`takeNew`). So new words
  are blocked by list, and therefore by language.
- With four lists at the default, up to 200 new words a day could come in.
  I did not confirm whether the all-lists path enforces each list's
  `newRemaining`; check before changing it.

## Findings

### (a) Interference and language similarity

- **Similarity mostly helps word learning; false friends are the risk.**
  Otwinowska (2024, _Second Language Research_ 40(3), 765–783,
  [doi:10.1177/02676583231176371](https://doi.org/10.1177/02676583231176371))
  reviews L3 word processing, cognate guessing and L3 word-learning
  experiments. Her conclusion: drawing on similarity (cognates)
  "predominantly facilitates acquiring L2 and L3 words", false cognates are
  the hazard, and the mechanisms are still unclear. Limitation: a narrative
  review with no pooled effect size.
- **Transfer is driven by similarity, property by property; "L2 status" is
  contested.** The older models are the L2 status factor (Bardel & Falk
  2007, [doi:10.1177/0267658307080557](https://doi.org/10.1177/0267658307080557))
  and the Typological Primacy Model (Rothman 2011,
  [doi:10.1177/0267658310386439](https://doi.org/10.1177/0267658310386439)).
  Both have since been revised. Westergaard's Linguistic Proximity Model
  (_SLR_ 37(3), 2021,
  [doi:10.1177/0267658319884116](https://doi.org/10.1177/0267658319884116))
  argues that transfer happens property by property and is driven by
  structural similarity. The systematic review by Puig-Mayenco, González
  Alonso & Rothman (_SLR_ 36(1), 2020,
  [doi:10.1177/0267658318809147](https://doi.org/10.1177/0267658318809147))
  says that "some factors are more influential than others". I could not open
  its full text, so its factor ranking and study count are **unverified**
  here. This whole literature is about **morphosyntax** in people who
  already speak an L2. It is not about two languages learned from zero in
  parallel.
- **Learning two foreign languages at once did not slow either one, in the
  one longitudinal study found.** Huang, Steinkrauss & Verspoor (_Int. J. of
  Multilingualism_ 19(4), 2022, online 2020,
  [doi:10.1080/14790718.2020.1779726](https://doi.org/10.1080/14790718.2020.1779726))
  followed L1-Chinese students for one academic year. One group learned
  English only; the other learned English and Russian together. The
  English+Russian group did not develop their English writing less, but
  their fluency varied more over time. Limitations: writing only, two
  dissimilar target languages, intact groups (not randomised). N is
  **unverified**.
- **Chinese and Japanese together:** I found no controlled study from 2018
  onward. The claim "don't learn similar languages at the same time" has no
  experimental support that I could find. It is folk advice.

### (b) Interleaved vs blocked practice for vocabulary

- **The meta-analysis is negative for "words", but the task differs from
  ours.** Brunmair & Richter (_Psychological Bulletin_ 145(11), 2019,
  [doi:10.1037/bul0000209](https://doi.org/10.1037/bul0000209)) pooled 59
  studies (238 effect sizes, 158 samples). Interleaving helped overall
  (g = 0.42) and most for paintings (g = 0.67, the Kornell & Bjork 2008
  paradigm,
  [doi:10.1111/j.1467-9280.2008.02127.x](https://doi.org/10.1111/j.1467-9280.2008.02127.x)).
  It **hurt** for word materials: g = −0.39, 95% CI [−0.64, −0.14], from
  only 13 effect sizes. The authors themselves warn that these were few
  studies, and that the negative result may reflect the category-learning
  tasks that used words rather than the words. Interleaving was stronger when
  the categories were more similar to each other. So Kornell & Bjork's
  result does not carry over directly to word pairs.
- **Interleaving two languages' vocabulary helped, probably through
  spacing.** Libersky, Sobus, Slawny & Kaushanskaya (_SLR_, online
  2025-06-16,
  [doi:10.1177/02676583251338768](https://doi.org/10.1177/02676583251338768))
  taught English-speaking adults German and Polish words, either interleaving
  the two languages or blocking them. In Experiment 1, interleaving won. In
  Experiment 2, a break was added midway, and the conditions no longer
  differed. The authors suggest the advantage "may stem from a spacing
  effect". Limitations: one session, two dissimilar languages, adults. N is
  **unverified** (I read the abstract only). This is the closest study to
  our question.
- **Interleaving two similar languages helped, in grammar.** Pan, Rodríguez
  Flores, Kaku & Lai (_Learning and Instruction_ 95, 102045, 2025,
  [doi:10.1016/j.learninstruc.2024.102045](https://doi.org/10.1016/j.learninstruc.2024.102045);
  [PDF](https://sc-pan.github.io/pdf/PRKL_2024.pdf)) ran four experiments
  (N = 92, 109, 104, 88). Each had two weekly sessions and a one-week
  delayed test. In Experiment 4, learners studied the Spanish and French
  present subjunctive together. Interleaving the two languages raised delayed
  conjugation accuracy (about 0.44 vs 0.35) and the ability to tell which
  language a sentence was in. Limitations: verb suffixes, not vocabulary;
  novices; online samples (Prolific).
- **Interleaving needs more than one session.** Pan, Tajran, Lovelett,
  Osuna & Rickard (_J. Educational Psychology_ 111(7), 2019,
  [doi:10.1037/edu0000336](https://doi.org/10.1037/edu0000336)) ran four
  experiments on Spanish conjugation (for example, 86 participants analysed
  in one of them). In a single session, interleaving showed no advantage;
  across two weekly sessions, it showed a clear one.
- **Words that are similar to each other cause intrusion errors, not lower
  scores.** Nakata & Suzuki (_SSLA_ 41(2), 2019,
  [doi:10.1017/S0272263118000219](https://doi.org/10.1017/S0272263118000219))
  had 133 Japanese university students recruited (116 analysed) learn 48
  English words. Semantically related sets did not lower posttest scores but
  **did** produce more interference errors. Spacing helped unrelated words
  more than related ones. This revises Tinkham (1993, _System_ 21(3)), which
  found related sets slower to learn; the later literature is mixed.
  Limitation: the similarity here is within one language (semantic sets),
  not across two target languages.

### (c) Spaced-repetition or flashcard studies with several languages

**None found.** Large SRS datasets span many courses: MaiMemo's 220 million
logs (Ye, Su & Cao, KDD 2022,
[doi:10.1145/3534678.3539081](https://doi.org/10.1145/3534678.3539081)) and
Duolingo's half-life regression (Settles & Meeder, ACL 2016,
[doi:10.18653/v1/P16-1174](https://doi.org/10.18653/v1/P16-1174)). Neither
analyses interference between languages a learner studies concurrently, as
far as I could see. The nearest SRS evidence is about spacing in general.
Kim & Webb (_Language Learning_ 72(1), 2022,
[doi:10.1111/lang.12479](https://doi.org/10.1111/lang.12479)) pooled 48 L2
experiments (N = 3,411, 98 effect sizes): spacing has a medium-to-large
effect, longer spacing beats shorter at delayed tests, and equal and
expanding spacing are equivalent. Lianki's own review logs could answer the
cross-language question; nobody else has published it.

### (d) Learner level

- Nakata & Suzuki (_Modern Language Journal_ 103(3), 2019,
  [doi:10.1111/modl.12581](https://doi.org/10.1111/modl.12581)): 115 Japanese
  learners, five English grammar structures, tested one week later.
  Interleaving beat blocking, and learners with **lower** pretest scores
  benefited **more**.
- Suzuki & Sunada (_SSLA_ 42(1), 2020,
  [doi:10.1017/S0272263119000470](https://doi.org/10.1017/S0272263119000470)):
  129 intermediate learners. A hybrid schedule (blocked, then interleaved)
  beat either schedule alone, and the effect interacted with prior
  knowledge.
- Both studies are about grammar. For vocabulary, I found no 2018-onward
  study of how a learner's level in each language changes the best ordering.
  Treat the beginner/intermediate distinction as **open**.

### (e) Daily new-word load and FSRS review growth

- The Anki manual
  ([deck options](https://docs.ankiweb.net/deck-options.html)): "If you are
  consistently learning 20 new cards a day, you can expect your daily reviews
  to be roughly about 200 cards/day." That is a rule of thumb from the SM-2
  era, not a study.
- The FSRS wiki
  ([The optimal retention](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-optimal-retention))
  treats workload as a function of target retention and gives no recommended
  number of new cards per day.
- **Our own rough simulation** used ts-fsrs default weights, Lianki's 365-day
  maximum interval, day granularity, reviews always done on time, and recall
  drawn from retrievability. It ignores the same-day 1m/5m learning steps.
  Reviews per day:

  | new/day | retention | day 30 | day 90 | day 180 | day 365 |
  | ------: | --------: | -----: | -----: | ------: | ------: |
  |      10 |      0.85 |     14 |     30 |      42 |      55 |
  |      20 |      0.85 |     33 |     65 |      67 |     125 |
  |      50 |      0.85 |     68 |    152 |     185 |     291 |
  |      20 |      0.90 |     50 |     88 |      99 |     155 |

  Load grows roughly linearly with new words per day and is still climbing
  at one year: about 6× N at 0.85, about 8× N at 0.90. Each new word also
  costs two or three same-day reviews for its learning steps. The figures are
  single-run and noisy; use them for order of magnitude only.
- The research literature has no evidence-based "sustainable" number. The
  limit is the learner's minutes per day.

## Recommendations for "Study all lists together"

Each one is tagged with how much evidence supports it.

1. **One daily new-word budget across all lists, not 50 per list.**
   (Evidence: workload arithmetic.) Default to about 20–30 new words a day
   in total, and show the projected review load ("≈ N reviews/day in 3
   months"), computed with the user's own FSRS parameters.
2. **Split the budget across languages with explicit shares.** (Product
   choice; no study.) An equal split is the default. Users can set weights,
   or choose "favour the language with the fewest mature words". No study
   shows that prioritising the weakest language helps, so make it an option,
   not the rule.
3. **Inside a session, introduce new words in short same-language runs
   (about 3–5), and interleave across languages between runs. Keep
   round-robin interleaving for due reviews.** (Moderate, indirect evidence:
   Libersky 2025, Pan 2025 Exp. 4, Suzuki & Sunada 2020's hybrid result.)
   Nothing supports today's fully blocked new-word order (one list until it
   is exhausted). The negative meta-analytic result for "words" comes from a
   different task.
4. **Rotate which language leads each day, so every language gets new words
   every day or two.** (Evidence: spacing, Kim & Webb 2022, and
   interleaving across sessions, Pan 2019.) Do not run one language for weeks
   and then switch.
5. **Don't avoid similar languages; separate confusable items.** (Weak to
   moderate evidence: Nakata & Suzuki 2019 SSLA, Otwinowska 2024.) Avoid
   introducing, on the same day or next to each other, words across two
   target languages that are translation equivalents with similar forms
   (for example Spanish _burro_ "donkey" vs Italian _burro_ "butter", or
   Chinese–Japanese kanji false friends). Space them a few days apart. Once
   both are mature, a contrastive pair card is reasonable.
6. **Measure it in Lianki.** Log cross-language intrusions: answers or
   self-reports that use the wrong language's word. Then A/B the new-word
   order (blocked vs short runs) on 7-day and 30-day retention per language.
   This would be new data; the literature has no SRS study of concurrent
   languages.

## Open questions and uncertainty

- No study tests vocabulary from two **similar** languages, both learned from
  scratch, under spaced repetition over weeks. Every recommendation above
  extrapolates from neighbouring settings: grammar, one session, dissimilar
  pairs, or L3 learners who already know an L2.
- Learner-level effects (d) are only shown for grammar.
- The review-load figures come from a simulation with default weights, not
  from Lianki users' data.
