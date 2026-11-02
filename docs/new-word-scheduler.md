# New-word scheduler: a walk over the list tree

Design. The pure scheduler and an owner-only simulator are in #372
(`lib/words/new-order.ts`, `/dev/new-order`). The study view does not use
them yet.

New words on /words come from a walk over the list tree. Each parent decides
how its children share the new words. Reviews are unchanged: every due card
is reviewed as it is now.

## The rules (owner, 2026-10-31, final as of 02:45 JST)

- **Inside a language** (Japanese: N5 → N4 → … → N1) the default is **in
  order**. The next level opens only when the previous list **passes**. Until
  then, every new Japanese word comes from the earliest open level. The owner
  does not mind N4 coming late.
- **Between languages** (the root) the default is **take turns**, so two
  languages are learnt at the same time.
- Every parent's mode can be changed: **in order**, **take turns**,
  **staggered** or **by weight**.
- **No daily caps and no per-list quotas.** Lianki is an endless-scroll app,
  not a time-boxed one (02:38). Shares are ratios of the stream.
- Dragging a list changes its priority.

Earlier drafts (#369, 02:30–02:44) had a staggered default, daily caps and a
choice between several gates. That came from a speech-to-text error ("don't
recommend" for "don't mind"), and all of it is dropped.

### Terms

| Term         | Meaning                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **seen**     | a word shown at least once (it has a card)                                                                                                                                                    |
| **progress** | the list's ring on /words (#351, `lib/words/progress.ts`): the mean word score, with `score = min(1, ln(1+stability) / ln(1+365))` and unseen words at 0. A group sums its subtree first |
| **pass**     | progress ≥ the pass mark, **60%** by default, adjustable per parent                                                                                                                           |
| **mastered** | progress 100%, every word known for about a year                                                                                                                                              |

## 1. What happens today

`Study` (`app/(app)/words/WordsClient.tsx`) takes new words from `takeNew(n)`:
the first list until it runs out, then the next one. That is strict
depth-first with no gate. `params.newPerDay` is counted on the server but
never enforced, so there is no daily cap today. That stays so: none is added.

## 2. Data model

```ts
// lib/words/new-order.ts
type NewOrderMode = "seq" | "rr" | "stagger" | "weighted";

type NodeOrder = {
  mode?: NewOrderMode; // unset = inherit (see below)
  passAt?: number; // seq, stagger: pass mark, 0..1, default 0.6
  ratio?: number; // stagger: an open child gets ratio× the next one's share, 1..4, default 2
};

type OrderNode = {
  id: string;
  size?: number; // leaves: words in the list
  seen?: number; // leaves: words seen
  score?: number; // leaves: Σ word scores (progress = score / size)
  weight?: number; // this node's weight in its parent: "weighted", and a factor in "stagger". 0 pauses it
  order?: NodeOrder; // parents
  children?: OrderNode[]; // in priority order = drag order
};
```

**Defaults and inheritance.** A parent with no `mode` takes it from the
nearest ancestor that sets one. If none does, it is `seq`. The root's own
setting is not handed down, because it is about languages. The root itself
defaults to `rr`. `passAt` and `ratio` are inherited the same way.

**Flat trees.** Most trees today have no language groups: every list sits at
the root. There, lists of the same language form one implicit language
bucket (`bucketByLanguage`), so the root takes turns between Japanese and
French, not between N5 and N1. Real language groups (the parallel work)
replace the buckets, and the result is the same.

A list that has child lists _and_ words of its own counts its own words as a
first child, `<id>:self`.

## 3. The scheduling function

```ts
nextLeaf(root, seen?, orders?): OrderNode | null // the list the next new word comes from
planNew(root, n, seen?, orders?): string[]       // the next n, each counted as seen for the next
```

At a parent:

1. **Open children.** For `seq` and `stagger`, child 0 is open, and child k
   is open when child k−1 is open and has **passed**. For `rr` and
   `weighted`, every child is open.
2. **Active children** are the open ones with unseen words left (and, in
   `weighted`, a weight above 0).
3. **Choose:**
   - `seq`: the first active child that can give a word (depth-first).
   - otherwise: stride scheduling over integer weights. `rr` gives each
     child weight 1. `weighted` uses each child's `weight`. `stagger` uses
     `weight × ratio^(m−1−k)` for the k-th of m active children, so with
     ratio 2 the shares are 67/33, 57/29/14 and so on. The pattern has
     length Σw. Its index is the number of words seen in the active
     children, mod Σw. If the child at that slot cannot give a word, the
     next slot is tried.
4. Recurse into the chosen child.

**Endless and stable.** No counter, clock or day enters the walk: it reads
only seen counts, progress and the tree. The sequence is the same after a
reload (test 12), on any device, and on any day. Words pulled into the queue
but not yet graded count as seen while the session plans ahead. After a
reload they are gone from both the queue and the counts, the cursors have
not moved, and the same words come back. A list studied on its own only
shifts the phase of the pattern. It causes no burst of catch-up (test 9).

**When a list passes**, its progress has been raised by reviews. The next
new word is then already drawn with the next list open ("opens
immediately"). That is stable for the same reason: it depends only on stored
state. There is no day boundary to wait for.

**Open question for the owner:** in order, when every word of N5 has been
seen and N5 still has not passed, Japanese gives no new words. The stream is
then Japanese reviews plus the other languages' new words (test 2c). The
alternative is to let a list whose words are all seen open the next one.

### In the study view (not built)

`takeNew(n)` becomes `planNew(tree, n)`. The picks are grouped per list,
filled by `takeNewFrom` (cursor, `/known` skipping), and merged in plan
order. A list that returns fewer words than asked counts as fully seen, and
the rest of the plan is drawn again. The due queue, learning steps and
grading are unchanged.

## 4. Where the settings live

- **Groups and parent lists:** `word_lists.params.newOrder` (and `weight` on
  each child row's params). This goes through the existing
  `PATCH /api/words/lists/:id`. The settings follow the account and move and
  delete with the group.
- **The root:** the account prefs of [prefs-sync.md](prefs-sync.md), key
  `words.newOrder`. Until those ship it is a local store.

## 5. UI

The ⋯ menu on a row **with children** gets **How new words come**. The
"Study all" row gets one too.

- **Same as above** (inherit), **In order**, **Take turns**, **Staggered**,
  **By weight**.
- **Pass mark: 60% progress** (slider), for In order and Staggered.
- **Ratio** (slider), for Staggered.
- A **weight** field on each child, for By weight and Staggered.
- A live preview at the bottom: "Next 10 new words: N5×6, N4×3, N3×1", with
  a strip coloured by list.
- Child order is the drag order.

`NewOrderSettings` and `NewOrderPreview` (`app/(app)/words/NewOrderControls.tsx`)
are those two pieces. `/dev/new-order` already uses them, so what the owner
tunes there is what the menu will show. The strings are in the `new-order`
dictionary (en, zh, ja), with a context line per key ([i18n.md](i18n.md)).

## 6. The simulator: /dev/new-order

The page is owner-only and saves nothing.

- **Trees:** presets (Japanese N5–N1 + French 500/1000/5000; Japanese only;
  flat lists) or **his real tree**. The real tree is read live from D1 on
  each load (the page is `force-dynamic`, SELECTs only), so any fix that
  changes seen or progress shows up at the next load.
- **Controls:** per list, sliders for seen and progress, and ↑/↓ for
  priority. Per parent, the ⋯ settings above.
- **Output:**
  - the first 100/300/1000 new words as a coloured strip;
  - the share per list over the first 300 and 1000;
  - **"N4 opens around <date>"**. For each closed next level, the previous
    list's progress is projected with ts-fsrs and its own parameters. Every
    seen card is reviewed when due and answered Good, and new words arrive
    at that list's pace over the last 14 days (`lib/words/gate-eta.ts`). This
    is information, not a setting, and it is optimistic: with no lapses, real
    dates come later.

With the owner's numbers in the 02:44 message (N5 1649/7966 seen, progress
about 6%), 60% needs most of those words seen and known for about a month on
average. That is many months, which the owner has accepted ("I don't mind N4
coming late"). The page shows the projected date from his live data.

## 7. Test cases

`unit/words-new-order.test.ts` in #372. A leaf is `L(id, words, seen, Σscore)`.

| #   | Tree                                                                        | Expected                                                |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | root: ja[N5(800), N4(600)], fr[A1(500)]                                     | N5 A1 N5 A1 N5 A1 N5 A1                                 |
| 2a  | ja: N5(1000, 998 seen, 59% progress), N4                                    | N5 N5, then nothing (N4 closed)                         |
| 2b  | the same at 60%                                                             | N5 N5 N4 N4 (N5's own words first)                      |
| 2c  | N5 all seen, 50%                                                            | nothing from Japanese; with French: A1 A1 A1            |
| 2d  | N5 all seen at 59.9%, then a review lifts it to 60%                         | null, then N4 at once                                   |
| 3   | staggered: N5 passed, N4 unseen                                             | N5 N5 N4 N5 N5 N4                                       |
| 3b  | staggered, three open (80%, 65%, 10%), N2 waiting                           | 14 words: N5 8, N4 4, N3 2                              |
| 4   | in order: N5 mastered and all seen, N4 70%, N3                              | N4 ×6                                                   |
| 5   | staggered, N5 passed: first 300                                             | N5 200, N4 100                                          |
| 6   | defaults, ja (N5 at 1%) + fr: first 300                                     | N5 150, A1 150, N4 0                                    |
| 7   | by weight 3:1                                                               | A A A B A A A B                                         |
| 8   | by weight with A = 0 / take turns ignores weights                           | B B B B / A B A B                                       |
| 9   | Japanese studied alone for 5 words, then all                                | A1 N5 A1 N5 … (no burst)                                |
| 10  | staggered ratio 3                                                           | N5 N5 N5 N4 …                                           |
| 11  | N4 dragged above N5                                                         | N4 ×4 (N5 waits for N4 to pass)                         |
| 12  | reload: 4 words, then 6 from the stored counts                              | equals 10 at once                                       |
| 13  | flat root N5(ja), N4(ja), A1(fr)                                            | buckets: N5 A1 N5 A1 …; unbucketed: N5 N4 A1            |
| 14  | inheritance: root by weight, ja staggered, jlpt inherits, kana take turns   | resolved modes as set; no ancestor setting → in order   |
| 15  | pass mark 30% on ja, inherited by jlpt                                      | N4 N4                                                   |
| 16  | empty tree / all seen / 2 words left                                        | [] / null / N5 N5                                       |

There is also a property test. In every mode the stream never gives more
words than are left, and the same input gives the same stream.
`unit/words-gate-eta.test.ts` covers the projection: it only grows, a faster
pace passes sooner, and 60% takes months, not days.

## 8. Estimate

In agent hours (agent wall-clock time). The scheduler, simulator and tests
are done (#372). What is left:

| Step                                                                               | Estimate |
| ---------------------------------------------------------------------------------- | -------- |
| Study view: build the tree, `takeNew` → `planNew`, draw again for a list that is out | 1.5 h    |
| Settings: `params.newOrder` and `weight` through the PATCH; the root in prefs        | 1 h      |
| The ⋯ "How new words come" menu, reusing the two components; zh/ja/… strings          | 1.5 h    |
| QA scenario on /words                                                              | 0.5 h    |

That comes to **about 4.5 agent hours**, once the owner has finished tuning
on the simulator.
