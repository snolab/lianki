---
title: "How FSRS Schedules Your Reviews"
date: 2025-01-15
tags: [fsrs, algorithm, spaced-repetition]
summary: "A walkthrough of the FSRS algorithm and how Lianki uses it to schedule reviews."
---

# How FSRS Schedules Your Reviews

_Posted January 15, 2025 by [lianki.com](https://www.lianki.com)_

Lianki uses FSRS — the Free Spaced Repetition System — to decide when you should review each card. This post explains what FSRS is, how it compares to older algorithms, and how it's implemented in Lianki.

## Why Not SM-2?

The dominant spaced repetition algorithm for decades has been SM-2, developed by Piotr Wozniak for SuperMemo in 1987. Anki uses a derivative of it. SM-2 works by tracking an "ease factor" per card and multiplying the previous interval by that factor after each review.

SM-2 has known problems:

- The ease factor can drift too low (the "ease hell" problem), causing cards to pile up
- It doesn't model forgetting curves accurately — it assumes all people forget at the same rate
- It has no concept of retrievability — how likely you are to remember something right now

FSRS was designed to fix these. It was developed by Jarrett Ye and is based on the DSR (Difficulty, Stability, Retrievability) model of memory.

## The Three Variables

FSRS tracks three things per card:

**Difficulty (D)** — How inherently hard this card is for you. Starts at a value derived from your first rating and updates slowly over time based on repeated performance. Cards you consistently find hard get a higher difficulty.

**Stability (S)** — How long you can go before forgetting. After a "Good" review, stability increases — meaning your next interval will be longer. After "Again", stability resets down.

**Retrievability (R)** — The probability you can recall the card right now, expressed as a percentage. This decays over time according to a forgetting curve. FSRS tries to schedule reviews when R drops to around 90% — just before you'd likely forget.

The forgetting curve is:

```
R(t) = e^(-t / S)
```

Where `t` is time elapsed and `S` is stability. Higher stability means slower decay.

## The Four Ratings

When you review a card in Lianki:

| Rating    | Meaning                    | Effect                                          |
| --------- | -------------------------- | ----------------------------------------------- |
| Again (1) | Forgot it                  | Stability resets, card re-enters learning phase |
| Hard (2)  | Remembered with difficulty | Small stability increase, shorter interval      |
| Good (3)  | Remembered correctly       | Normal stability increase                       |
| Easy (4)  | Too easy                   | Large stability increase, longer interval       |

The new interval is chosen so that retrievability at the next review date will be approximately 90%.

## How Lianki Uses ts-fsrs

Lianki uses the [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) library. Here's the core of the review flow in `app/fsrs.ts`:

```typescript
import { createEmptyCard, fsrs } from "ts-fsrs";

const f = fsrs();

// When showing review options to the user:
const schedulingCards = f.repeat(card, now);

// schedulingCards contains one entry per rating (Again/Hard/Good/Easy)
// Each entry has: card (updated state), log (review record), and due date
```

The `repeat()` call computes all four possible next states at once. Lianki shows these to the user via the `/api/fsrs/options` endpoint, which returns the due date for each rating. The review UI displays these as human-readable intervals like "2d 3h" using the `enhanced-ms` library.

When the user picks a rating, `/api/fsrs/review/:rating` applies the chosen scheduled card to MongoDB:

```typescript
const { card, log } = schedulingCards[rating];
await collection.updateOne({ url }, { $set: { card }, $push: { log } });
```

## Card States

FSRS cards move through four states:

```
New → Learning → Review → Relearning
                    ↑           ↓
                    ←←←←←←←←←←←
```

- **New**: Never reviewed
- **Learning**: Recently introduced, short intervals (minutes to days)
- **Review**: Long-term review, intervals in days to months
- **Relearning**: Forgot during Review phase, re-entering short intervals

Lianki doesn't expose these states directly in the UI — you just see the due date and review when it's time.

## The Fuzz Factor

FSRS applies a small random variation to intervals by default. Without fuzz, if you add 50 cards on the same day and review them all as "Good", they'd all pile up on the exact same future date. Fuzz spreads them out slightly to prevent review avalanches.

## Default Parameters

Lianki uses the default FSRS parameters from `ts-fsrs`. FSRS v5 supports per-user parameter optimization using review history, but Lianki hasn't implemented that yet — it's a planned feature. The default parameters are trained on a large dataset of real flashcard reviews and work well for most people.

---

**License**: This work is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). You are free to share and adapt this content with attribution.
