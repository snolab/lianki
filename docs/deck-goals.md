# Deck Goals, Domain Grouping, and Exam Deadlines

Design note extending the owner's request (2026-11-27 01:48–01:49 JST).

## Problem

Today all saved web-page cards share one flat review pool. That keeps capture zero-friction, but:

1. Learners cannot easily view or focus on cards from a specific exam, topic, or source site.
2. Exam-oriented decks (e.g., TOEFL, Fundamental Information Technology Engineer / 基本情報技術者) have a fixed **deadline**, so learners need to know whether their current pace will finish the deck in time before the exam.

## Goals

- **Zero-config default**: Keep mixed review across all cards as the default behavior so casual capture requires no setup.
- **Lightweight organization**: Group cards automatically by source domain or manually by tag / deck.
- **Deadline & pace awareness**: Let any deck carry a target date (deadline) and show a live countdown + pace status derived from FSRS progress.

## Core Design

### 1. Decks, Tags, and Domain Grouping

- **Default pool**: Newly saved cards still enter the unified review stream without forcing the user to pick a deck.
- **Automatic domain groups**: Cards with a source URL can be grouped automatically by host/domain (e.g. exam prep site, YouTube, Zhihu) as virtual views.
- **Manual decks / tags**: Users can group cards into named decks or tags (e.g. `TOEFL`, `基本情報技術者 令和X年`). A card can belong to one primary deck or multiple tags.

### 2. Review Mixing & Focus

- **Mixed by default**: Normal review draws from all decks together.
- **One-click focus**: Tapping a deck lets the user study only that deck for the current session.
- **Mix weight**: Each deck can optionally carry a priority/weight (normal / boosted) so an upcoming exam deck surfaces more often even in mixed mode.

### 3. Deck Deadlines & Daily Pace

Each deck can optionally set:

- **Deadline**: Target exam or completion date.
- **Target** (optional): e.g. finish all unseen cards before the deadline and maintain target retention (e.g. 85%+).

From the remaining days until `deadline`, unseen card count, projected FSRS due reviews, and recent 7-day completion rate, the deck computes:

- **Countdown**: Days remaining until the deadline.
- **Required daily pace**: Estimated cards (or minutes) per day needed to finish on time.
- **Pace status** (3 states):
  - **On track** (`🟢`): Current 7-day pace meets or exceeds required daily pace.
  - **Behind pace** (`🟡`): Shows the exact daily gap (e.g. "+N cards/day needed") and offers a one-tap boost to increase this deck's mix weight.
  - **At risk / Exam sprint** (`🔴`): Close to the deadline with significant unseen or low-stability cards remaining; suggests switching to sprint priority (surface high-value / low-stability / unseen cards first, pause low-priority new cards from other decks).

### 4. UI Surface (Minimal)

On each deck row/card, show only three primary signals:

1. **Countdown** (when a deadline is set, e.g. `18d left`).
2. **Progress** (mastered / total or unseen remaining).
3. **Pace badge** (`On track` / `Behind pace` / `At risk`).

### 5. Integration Points

- **FSRS scheduler**: Uses existing card `due`, `stability`, and review history to estimate retention and review load.
- **`/roadmap` & `/calendar`**: A deck with a deadline naturally maps to a dated milestone node in the study plan / Gantt timeline.

## Non-Goals (v1)

- Mandatory folder/deck selection during web capture.
- Complex nested deck hierarchies (flat decks/tags + automatic domain groups are sufficient for v1).
