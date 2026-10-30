# New-word scheduler: a walk over the list tree

Design, not built yet. Owner request (2026-10-31 02:30–02:31 JST): the order
in which /words brings **new** words is a walk over the list tree, and each
parent decides how its children share the new words.

- Inside a language (Japanese: N5 → N4 → … → N1) the levels are learnt in
  order, but **N4 must not start too late** (02:31: "I don't recommend N4
  starting so late"). So the default is **staggered**: N4 starts once N5 is
  60% seen, then both run, and N5 gets the larger share. N3 starts once N4 is
  60% seen, and so on down the chain.
- At the root (Japanese and French) the languages **take turns**, so two
  languages are learnt at the same time.
- Strict order, take turns and by weight stay available as modes, and each
  parent can cap how many new words one child gets a day.
- Only the choice of **new** words changes. Every due card is reviewed as it
  is now.
- Dragging a child up or down changes its priority.
- It works with the parent progress %, "Study all lists together" and the
  global daily new-word limit.

Research on learning several languages at once (`docs/research/multilingual-scheduling.md`)
has not landed when this was written. When it lands, link it here as the
source for the defaults (60%, a ratio of 2, take turns between languages). The
defaults below are the owner's.

## 1. What happens today

- `Study` (`app/(app)/words/WordsClient.tsx`) gets the lists in scope in tree
  order (`flatten`, `lib/words/tree.ts`). That is one list, a group and its
  subtree, or every list for "Study all lists together". Group rows
  (`source = "group:<page>"`) hold no words.
- Due words come first, merged round-robin across lists (`interleave`).
- New words come from `takeNew(n)`: **the first list until it runs out, then
  the next**. That is strict depth-first at every level. The picker says so
  under "Study all": "New words come in the order below." (`studyAllHint`).
- Each list stores a `cursor` (its next catalog index) and `new_day` /
  `new_today` (new words introduced on that local day). It also stores
  `params.newPerDay` (default 50). The server counts it and returns
  `newRemaining`, but **the study view never reads it**, so today there is
  no daily cap in practice. The only end is the catalog's end.

The scheduler replaces only `takeNew`'s choice of _which list_ each new word
comes from. `takeNewFrom` (the cursor, `/known` skipping and the catalog
loads), the due queue, `spreadPairs` and the learning-step re-queue all stay
as they are.

## 2. Data model

Every parent has a `NewOrder`. A parent is a group row, a list with child
lists, or the page root ("Study all").

```ts
// lib/words/new-order.ts
export type NewOrderMode =
  | "stagger" // the next child starts at startAt seen; open children share, older ones more
  | "seq" // strict order: a child's new words all come before the next child's
  | "rr" // take turns: equal shares
  | "weighted" // shares in proportion to weights
  | "auto"; // root only: take turns between languages, stagger within each

export type NewOrder = {
  mode?: NewOrderMode; // unset = the default for this kind of node (below)
  /** stagger: the share of a child's words seen before the next child opens. */
  startAt?: number; // 0.1–1.0, default 0.6
  /** stagger: an open child gets `ratio` times the share of the one after it. */
  ratio?: number; // 1–4, default 2 (1 = equal shares among open children)
  /** weighted: weight per child id; a missing child weighs 1, 0 pauses it. */
  weights?: Record<string, number>; // each 0–10, at most 50 entries
  /** At most this many new words a day from each child's subtree; null = off. */
  childCap?: number | null; // 1–1000, default null
};
```

**Defaults when `mode` is unset:**

| Node                                                | Default   |
| --------------------------------------------------- | --------- |
| a group, a parent list, a language container        | `stagger` |
| the page root ("Study all lists together")          | `auto`    |
| the root after the user picks a mode in the ⋯ sheet | that mode |

`auto` buckets the root's children by language: a list's `lang`, or a group's
first leaf's `lang`. The buckets take turns, in order of first appearance, and
the members of one bucket are staggered in saved order. With language
containers (the parallel work on Japanese and French parent groups) every
root child is already one language, so `auto` is the same as `rr` over those
containers. Without them (flat lists at the root, everyone's tree today)
`auto` still does what the owner described: N5 and N4 overlap, and Japanese
and French take turns.

**A parent list with words of its own** (a list that has child lists) counts
its own words as a virtual first child, `self`, ahead of its children.

**Global cap:** `newPerDay: number | null` per page. It counts every new word
introduced today on that page, in any scope. The default is null (no limit),
which is today's behaviour.

**`params.newPerDay` on a list** (default 50, never enforced) is no longer
read by the scheduler. A child's daily cap is its parent's `childCap`. The
field stays where it is, so nothing needs migrating. Remove it in a later
cleanup.

## 3. The scheduling function

```ts
// Pure, no I/O. lib/words/new-order.ts
export type PlanLeaf = {
  id: string;
  size: number; // words in the list: the figure the picker's ring divides by
  seen: number; // words with a card (WordList.cards), plus ones pulled this session
  today: number; // new words today: new_today when new_day is today, plus pulled this session
};
export type PlanNode = PlanLeaf | { id: string; order: NewOrder; children: PlanNode[] };

/** The leaf the next new word comes from, or null when the scope has none left today. */
export function nextLeaf(root: PlanNode, globalLeft: number | null): string | null;

/** The next n leaves, in order: nextLeaf n times, adding each pick to seen and today. */
export function planNew(root: PlanNode, n: number, globalLeft: number | null): string[];
```

For a subtree `c`, `t(c)` is the sum of `today` over its leaves, `size(c)` the
sum of `size`, and `seen(c)` the sum of `seen`. Its **seen share at day
start** is `(seen(c) − t(c)) / size(c)`.

`nextLeaf(node)`:

1. A leaf: its id if `seen < size`, else null.
2. Which children are **open**:
   - `stagger`: child 0 is open. Child k is open when child k−1 is open and
     its seen share at day start is at least `startAt` (a finished child
     counts 100%). The chain is checked against the start of the day, so a
     list that crosses 60% mid-session opens the next one **tomorrow**, and
     no list jumps in halfway through a session.
   - all other modes: every child.
3. **Active** children: open, with unseen words left. They are numbered
   `a₀ … a₍ₘ₋₁₎` in priority order, which is the saved sibling order (what
   dragging changes).
4. **Weights:** `rr` and `auto` 1 each, `weighted` `weights[id] ?? 1`, and
   `stagger` `w(aₖ) = ratio^(m−1−k)`.
5. **Candidates:** active children with `w > 0` and `t < childCap` (when set)
   whose own `nextLeaf` is non-null.
6. **Choose:**
   - `seq`: the first candidate.
   - every other mode: the candidate with the smallest `(t(c) + 1) / w(c)`.
     A tie goes to the earlier child.
7. Recurse into the chosen child.

The root returns null once `globalLeft` reaches 0.

**The budget split (stagger).** Step 6 is stride scheduling: over a day, each
active child gets a share of the new words that is proportional to its
weight. With `ratio = r` and `m` active children:

```
share(aₖ) = r^(m−1−k) / Σⱼ rʲ  =  r^(m−1−k) · (r − 1) / (rᵐ − 1)
```

| active | r = 2 (default)            | r = 3                   |
| ------ | -------------------------- | ----------------------- |
| 1      | 100%                       | 100%                    |
| 2      | 67 / 33                    | 75 / 25                 |
| 3      | 57 / 29 / 14               | 69 / 23 / 8             |
| 4      | 53 / 27 / 13 / 7           | 68 / 23 / 8 / 3         |

**Recommended: geometric, r = 2** ("the older one gets twice the newer one's
share"). It is easy to predict, a new level starts gently, and a finished
level simply drops out, so its share moves to the rest. The alternatives
considered:

- **Linear** (m, m−1, …, 1): milder, so with four levels open N5 gets only
  40%.
- **Proportional to the unseen words left**: this inverts the owner's
  intent. An untouched N4 (all its words unseen) outweighs an N5 at 60%, and
  every share drifts as words are seen. Rejected.

**Deterministic and stable across reloads.** `nextLeaf` reads only stored
state: the tree and its order, the settings, each list's `cards`, size and
`new_day`/`new_today`, and the local day. It also reads the words pulled into
this session's queue but not yet graded. Nothing random, nothing time-based
and no hidden counter is involved. After a reload those ungraded words are
gone from both the queue and `today`, the cursors have not moved, so the same
words come back in the same order (test 13). Undo of a new word already
decrements `new_today` on the server, so the plan steps back with it.

**A day's turns.** `t` counts today's words in any scope. If you study
Japanese on its own for 5 words and then open "Study all", French gets the
next 5, and after that the two alternate (test 9). Taking turns is per day,
not per session. That is the point of a daily balance. A `childCap` bounds
it.

### How it plugs into the study view

- `Study` builds the `PlanNode` tree from the lists in scope once the session
  loads. That is `flatten` + `parentId`, plus the settings from section 4.
  Studying a group makes that group the walk's root, and it keeps its own
  mode. Studying one list is a single leaf. "Study all" is the page root.
- `takeNew(n)` becomes `planNew(tree, n, globalLeft)`. The picks are grouped
  per leaf and filled with `takeNewFrom(list, k)`, then merged back in plan
  order. When a leaf returns fewer words than asked (end of its catalog,
  after `/known` skips), it is marked finished (`seen = size`) and the
  remainder is re-planned.
- `globalLeft = newPerDay − Σ today` over the page's lists, or null.
- Due words, the learning-step queue (`later`) and grading are unchanged.
  When the plan returns nothing (caps reached), the queue ends with the due
  words, and the empty tray says "No more new words today" (a new string).
- Offline it runs the same function on the cached lists (`idb` `lists`).

### Progress %

Not changed. The ring stays the stability-weighted mean
(`lib/words/progress.ts`). The stagger threshold uses the **seen** share
(`cards / words`, the `seen` figure in the row's stats line), not the
progress %. "Seen" moves one word at a time and is what "has N5 been gone
through" means. Progress needs months of reviews to reach 60%, and N4 would
indeed start too late.

## 4. Where the settings live

**Recommended: on the list rows, and only the root in account prefs.**

- **Groups and parent lists:** `word_lists.params.newOrder`, next to
  `retention` and the rest. `normalizeParams` gains a `normalizeNewOrder` that
  clamps every field and drops weights for ids that are not children. The
  existing `PATCH /api/words/lists/:id { params }` writes it, and
  `GET /api/words/lists` already returns it to every device. That way it
  follows the account, it moves with the group when the group is dragged, and
  it is deleted with the group. A deleted child's weight is dropped at the
  next normalize. No migration and no new table.
- **The page root** has no row. It goes in the account prefs designed in
  [prefs-sync.md](prefs-sync.md) (#367), as two registry keys on the
  `words` store:
  - `words.newOrder`: the `NewOrder` object above, as a zod schema. List ids
    are random ids, not URLs, so this passes prefs-sync's privacy test, and
    it fits the 2 KB value cap with 50 weights.
  - `words.newPerDay`: `number | null`, the global cap.
  The alphabets page gets its own pair (`alphabets.newOrder`, …) when it
  wants one.
  Until prefs-sync phase 2 ships, these two are a `local` store
  (`lk:pref:words-order`). Making that store `account` later moves no data
  (prefs-sync section 7).
- prefs-sync.md section 1 gains two rows (synced, "a study habit").

The alternative is to put every node's setting in prefs, keyed by list id. It
was rejected: the value grows with the tree, it outlives deleted lists, and a
group's settings would not travel with the group.

## 5. UI

The ⋯ menu on each row (#359: Rename, Delete) gains **New words…** on rows
that have children, and the "Study all lists together" row gets a ⋯ with the
same item. It opens a sheet (the Settings sheet's style):

```
New words in Japanese
  ◉ Staggered      The next list starts when this one is 60% seen.   [ 60% ▾ ]
  ○ In order       Finish one list before the next.
  ○ Take turns     The lists take turns, one word each.
  ○ By weight      More weight, more new words.   (a 0–10 stepper on each child row)
  ☐ At most [ 20 ] new words a day from each list
```

On the root the first option is **By language** ("Languages take turns;
within a language, levels overlap."). The sheet also has **New words a day
(all lists)** with a "No limit" choice.

- The row's stats line shows the mode once it is not the default, e.g.
  "take turns".
- `studyAllHint` ("New words come in the order below.") becomes one line per
  mode.
- Dragging stays the way to change priority, and the sheet says so: "Drag
  the lists to change which comes first."
- The ratio (r) has no control in v1. It is stored, so it can get one later.

Strings, `words-page` dictionary, each with its context line
([i18n.md](i18n.md)). The context goes in the content file's `context`
record:

| key                    | en                                                         | context                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `newWordsItem`         | New words…                                                 | Item in the ⋯ menu of a group row or the 'Study all' row; opens a sheet choosing how new words are shared among the lists under it. Keep the ellipsis. |
| `newWordsTitle`        | New words in {name}                                        | Heading of that sheet; {name} is the group's name or 'all lists'. Noun phrase, not an action.                                                  |
| `orderStagger`         | Staggered                                                  | Radio option, a mode name: lists start one after another but overlap. An adjective describing the order, not a verb.                          |
| `orderStaggerHint`     | The next list starts when this one is {pct}% seen.         | Line under 'Staggered'; {pct} is the threshold (default 60). 'Seen' = words shown at least once, not learnt.                                   |
| `orderSeq`             | In order                                                   | Radio option, a mode name: all new words of the first list before any of the next. Short adverbial phrase.                                     |
| `orderSeqHint`         | Finish one list before the next.                           | Line under 'In order'. Imperative-sounding description of the mode, not an instruction to the user to do something now.                        |
| `orderRr`              | Take turns                                                 | Radio option, a mode name: the lists alternate, one new word each. Not 'round robin' jargon.                                                   |
| `orderRrHint`          | The lists take turns, one word each.                       | Line under 'Take turns'.                                                                                                                       |
| `orderWeighted`        | By weight                                                  | Radio option, a mode name: each list gets new words in proportion to a number the user sets per list.                                          |
| `orderWeightedHint`    | More weight, more new words.                               | Line under 'By weight'.                                                                                                                        |
| `orderAuto`            | By language                                                | Radio option on the 'all lists' sheet only: languages alternate, and inside one language the levels overlap. Mode name.                        |
| `orderAutoHint`        | Languages take turns; within a language, levels overlap.   | Line under 'By language'. 'Levels' = word lists such as JLPT N5, N4.                                                                           |
| `weightOf`             | Weight of {name}                                           | Screen-reader label of the 0–10 stepper on a child row in 'By weight' mode; {name} is the list.                                                |
| `childCap`             | At most {n} new words a day from each list                 | Checkbox with a number field; {n} is the field. Limits each child list under this group per local day.                                         |
| `newPerDay`            | New words a day (all lists)                                | Label of the global daily limit on the 'all lists' sheet; a number field follows.                                                              |
| `noLimit`              | No limit                                                   | Choice next to the daily-limit field meaning the limit is off.                                                                                 |
| `dragHint`             | Drag the lists to change which comes first.                | Line at the foot of the sheet; refers to the drag handles (⠿) on the list rows.                                                                |
| `noMoreNewToday`       | No more new words today                                    | Empty-tray message when the daily limits are reached but reviews may still come. Not an error.                                                 |
| `studyAllHint{Mode}`   | (one per mode, e.g. "Languages take turns.")               | Line under 'Study all lists together' describing the current mode in one short sentence.                                                       |

Translation follows i18n.md: `intlayer fill` reads the context, and one
batch covers the whole sheet so the five mode names agree with each other.

## 6. Migration

Nothing is stored for existing users, so the question is only what an unset
`mode` means.

1. **Recommended: the owner's defaults for everyone.** Groups are
   `stagger`, and the root is `auto` (by language). A Japanese learner with
   N5 → N1 at the root gets one language bucket, staggered, so N4 starts at
   60% of N5. Someone with Japanese and French gets them taking turns. That
   is exactly the request, it needs no data change, and the language
   containers drop in later with the same result.
2. Keep today's order (`seq` at the root and in groups) until the user picks
   something. Nothing changes for anyone, but nobody gets the new behaviour
   unless they find the sheet.
3. Plain `rr` over the root's children. That is wrong for today's flat
   trees: N5 and N1 would take turns.

With (1), the first "Study all" after the release changes order: N4 words
appear where only N5 words did before. A one-time note on the picker ("New
words now overlap levels and alternate languages. Change in ⋯.") points to
the sheet. A list being "seen" for stagger counts the words already seen,
including words from studying one list on its own. Lists already past 60%
open their next one on the first day.

## 7. Test cases

`unit/words-new-order.test.ts`. The defaults are startAt 0.6 and ratio 2. A
leaf is written `name(size, seen, today)`, with 0 today unless given. The
sequences below were checked against a prototype of section 3.

| #   | Tree                                                                                       | Expected next picks                                    |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | root auto: Japanese[N5(800,0), N4(600,0)], French[A1(500,0)]                               | N5 A1 N5 A1 N5 A1 N5 A1                                |
| 2a  | Japanese stagger: N5(1000, **590**), N4(600,0)                                             | N5 ×6 (59% < 60%: N4 closed)                           |
| 2b  | Japanese stagger: N5(1000, **600**), N4(600,0)                                             | N5 N5 N4 N5 N5 N4                                      |
| 2c  | N5(1000, 610, today 20): 590 at day start                                                  | N5 ×6 (opens N4 tomorrow, not mid-session)             |
| 3   | three active: N5(800,640) 80%, N4(600,390) 65%, N3(600,60) 10%, N2(1000,0)                 | N5 N5 N4 N5 N5 N4 N3 N5 N5 N4 N5 N5 N4 N3 (4:2:1; N2 closed) |
| 4   | finished drops out: N5(800,800), N4(600,420), N3(600,0)                                    | N4 N4 N3 N4 N4 N3                                      |
| 5   | finishes mid-day: N5(800,798), N4(600,400)                                                 | N5 N5 N4 N4 N4 N4                                      |
| 6   | seq, childCap 3: N5, N4, N3 all unseen                                                     | N5 N5 N5 N4 N4 N4 N3 N3                                |
| 6b  | seq, no cap                                                                                | N5 N5 N5 N5 N5 (today's behaviour)                     |
| 7   | weighted A=3, B=1                                                                          | A A A B A A A B                                        |
| 8   | root auto, global cap 5: Japanese[N5], French[A1]                                          | N5 A1 N5 A1 N5, then nothing                           |
| 9   | root auto, Japanese studied alone for 5 today                                              | A1 A1 A1 A1 A1 N5 A1 N5                                |
| 10  | stagger ratio 3: N5(1000,700), N4                                                          | N5 N5 N5 N4 N5 N5 N5 N4                                |
| 11  | drag N4 above N5: N4(600,0), N5(1000,700)                                                  | N4 ×6 (N5 now waits for N4 to reach 60%)               |
| 12  | root rr, childCap 2: Japanese[N5], French[A1]                                              | N5 A1 N5 A1, then nothing                              |
| 13  | reload: root auto, Japanese[N5(800,600), N4], French[A1]; plan 10 vs plan 4, then plan 6   | both N5 A1 N5 A1 N4 A1 N5 A1 N5 A1                     |
| 14  | flat root, no containers: N5(ja), N4(ja), A1(fr)                                           | same as test 1 (language buckets)                      |
| 15  | parent list with own words + child list                                                    | `self` is child 0, then the child list opens at 60%    |
| 16  | weight 0 / every child capped / empty tree / cycle in parentId                             | that child never picked / null / null / each node once |

There is also a property test. For random trees, `planNew(n)` equals n
calls of `nextLeaf` with the state applied in between. It never exceeds
`childCap` or the global cap, and no mode changes the due queue. A QA step in
`scripts/qa/qa-words.mjs` sets "Take turns" on a two-list group and checks
that the first new rows alternate.

## 8. Estimate

In agent hours (agent wall-clock time).

| Step                                                                                                               | Estimate |
| ------------------------------------------------------------------------------------------------------------------ | -------- |
| `lib/words/new-order.ts` (`nextLeaf`, `planNew`, language buckets, `normalizeNewOrder`) and the unit tests above   | 2 h      |
| Study wiring: build the tree, replace `takeNew`, re-plan on an exhausted leaf, global cap, "no more new words today" | 2 h      |
| Settings: `params.newOrder` through the existing PATCH; the root and global cap store (local now, account with #367) | 1 h      |
| UI: the ⋯ "New words…" sheet, weight steppers, the cap field, per-mode hints, strings with context in 16 locales     | 2.5 h    |
| QA scenario, prefs-sync table rows, docs                                                                           | 1 h      |

**About 8.5 agent hours.** The root's sync across devices waits for
prefs-sync phase 2. Group settings sync from day one, because they ride on
the list rows.

## Compatibility with the language parent groups

That work (Japanese and French containers with the level lists under them)
had no open PR when this was written. This design assumes only what the tree
already has: group rows with `parentId` children and `params`. A language
container is a group, so it defaults to `stagger`, and the root's `auto`
makes containers take turns. If containers get a `lang` of their own,
`auto` uses it instead of the first leaf's.
