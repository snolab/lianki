---
title: "Supercharge Your Japanese Learning: Combining jpdb.io with Lianki"
date: 2025-02-20
tags: [japanese, jpdb, workflow, vocabulary]
summary: "Learn how to integrate jpdb.io vocabulary reviews into your Lianki spaced repetition workflow for more efficient Japanese learning."
---

# Supercharge Your Japanese Learning: Combining jpdb.io with Lianki

If you're learning Japanese, you're probably familiar with the challenge of balancing vocabulary acquisition with immersion in native content. Today, I want to share a powerful workflow that combines two excellent tools: [jpdb.io](https://jpdb.io) for vocabulary building and Lianki for spaced repetition of your learning materials.

## What is jpdb.io?

[jpdb.io](https://jpdb.io) is a comprehensive Japanese learning platform that combines a massive native content database with an intelligent spaced repetition system. According to [Tofugu's review](https://www.tofugu.com/japanese-learning-resources-database/jpdb-io/), it's quickly becoming a one-stop-shop for Japanese learners.

### Key Features of jpdb.io

**21,434+ Pre-built Decks**: Vocabulary from 1,399 anime, plus visual novels, light novels, web novels, and other Japanese media. Want to watch your favorite anime? Study its vocabulary first!

**130+ Million Real Sentences**: When you learn a new word, jpdb automatically shows you **i+1 sentence cards** — example sentences where you already know everything except the new word you're learning.

**Modern ML-based SRS**: Instead of the old SM-2 algorithm from the 1980s, jpdb uses a machine-learning approach that handles lapses and irregular reviews more intelligently.

**Custom Kanji Keywords**: Similar to Heisig's _Remembering the Kanji_, but with manually curated, better keywords for thousands of kanji.

## What Does Lianki Provide?

Lianki is a modern spaced repetition system built around the [FSRS algorithm](https://github.com/open-spaced-repetition/fsrs) — the same advanced algorithm used by Anki's latest versions. Here's what makes Lianki special for Japanese learners:

### Browser-First Workflow

**One-Click Card Creation**: Install the [Lianki userscript](https://www.lianki.com/lianki.user.js) (Tampermonkey/Violentmonkey) and press `Alt+F` on any webpage to add it as a flashcard. Bulk add multiple URLs with `Alt+Shift+V`.

**Inline Reviews**: Review cards without leaving your current page. The userscript overlays the review UI directly on top of whatever you're reading or watching.

**Keyboard-Driven**: Rate your recall with `1-4` (Again/Hard/Good/Easy) or `HJKL`/`ASDT`. Navigate with media keys. No mouse needed.

### FSRS Algorithm

Lianki uses the **DSR model** (Difficulty, Stability, Retrievability) to schedule reviews more accurately than older algorithms:

- **Difficulty**: How inherently hard the card is for you
- **Stability**: How long you can remember before forgetting
- **Retrievability**: Probability you can recall right now (aims for ~90%)

Cards get scheduled when you're about to forget them — maximizing retention while minimizing review time.

## The Workflow: jpdb.io + Lianki

Here's the magic combination: **Add `https://jpdb.io/review` as a Lianki card.**

### How It Works

1. **Add jpdb.io/review to Lianki**:
   - Visit `https://jpdb.io/review`
   - Press `Alt+F` (with the Lianki userscript installed)
   - Your jpdb review page is now a flashcard in Lianki

2. **Lianki schedules jpdb reviews using FSRS**:
   - Instead of manually checking jpdb every day, Lianki reminds you based on optimal spaced repetition timing
   - Rate it "Good" (press `3`) when you complete your jpdb reviews
   - Rate it "Again" (press `1`) if you skipped or struggled

3. **Learn vocabulary while looping through your materials**:
   - Your Lianki queue might look like:
     - An anime episode URL (due today)
     - `jpdb.io/review` (due today)
     - A manga chapter URL (due tomorrow)
     - A Japanese podcast URL (due in 3 days)

4. **The loop**:
   - Watch the anime → review it in Lianki → hit jpdb to study new words from that anime
   - Next time Lianki shows you the anime card, you'll know more vocabulary
   - The anime gets easier with each loop

### Why This Works

**Vocabulary in Context**: You learn words from jpdb, then immediately encounter them in the content you're reviewing in Lianki.

**Double Reinforcement**: Lianki spaces out your content reviews (anime, manga, articles). jpdb spaces out your vocabulary reviews. Together, they create a reinforcement loop.

**Frictionless Integration**: Because jpdb.io/review is just another card in your Lianki queue, you don't need to context-switch between tools or maintain separate study schedules.

**Gamification**: Both systems use SRS, but Lianki's inline review UI and keyboard shortcuts make the _process_ of reviewing feel more fluid and game-like.

## Advanced Tips

### Add Specific jpdb Decks

Instead of just `jpdb.io/review`, you can add specific deck URLs as separate cards:

- `https://jpdb.io/anime/4072/revisions/vocabulary-list` (Revisions anime)
- `https://jpdb.io/vocabulary-list/924/japanese-language-proficiency-test/2/n4/vocabulary-list` (JLPT N4)

This lets you loop through specific decks when Lianki schedules them, rather than jumping into the global review queue.

### Use Lianki's Bulk Add for Entire Seasons

If you're watching a whole anime season, add all episode URLs at once:

1. Copy all episode URLs (one per line)
2. Press `Alt+Shift+V`
3. Lianki will create cards for each episode
4. As you watch and review each episode, add the corresponding jpdb deck as a card

Now your SRS schedule interleaves content (episodes) with vocabulary (jpdb).

### Track Your Progress

Lianki shows you a **GitHub-style activity heatmap** on the homepage. Each day you review becomes a green square. This visual feedback helps you maintain streaks and see patterns in your study habits.

## Getting Started

1. **Sign up for jpdb.io**: It's free for basic use ([Patreon](https://www.patreon.com/jpdb) for premium features)
2. **Install Lianki userscript**: Get it from [lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js)
3. **Add your first jpdb deck**: Press `Alt+F` on `https://jpdb.io/review`
4. **Add some content**: Browse to an anime episode, manga chapter, or Japanese article and press `Alt+F`
5. **Start reviewing**: Visit [lianki.com](https://www.lianki.com), click "Next card", and follow the review flow

## Why Not Just Use Anki?

You can absolutely use Anki for this! But Lianki offers some advantages for immersion learners:

- **URL-based cards**: Designed for web content (articles, videos, manga readers), not isolated facts
- **Browser integration**: No need to copy/paste — one hotkey adds any page
- **Lightweight**: No desktop app to install, works everywhere via userscript
- **Content-first**: Optimized for reviewing _materials_ (that teach you vocabulary) rather than individual words

jpdb handles the word-level drilling. Lianki handles the content-level repetition. Together, they cover both bases.

## Conclusion

Combining jpdb.io's vocabulary system with Lianki's content-based spaced repetition creates a powerful Japanese learning workflow. You're not just memorizing words in isolation — you're cycling through real content where those words appear, reinforced by jpdb's targeted vocabulary decks.

Give it a try for a week. Add `jpdb.io/review` to your Lianki queue, throw in some anime episodes or manga chapters, and see how the loop accelerates your learning.

Happy looping! 練習がんばって！

---

**Further Reading**:

- [jpdb.io FAQ](https://jpdb.io/faq)
- [How FSRS Schedules Your Reviews](https://www.lianki.com/en/blog/2025-01-15-fsrs-algorithm) (Lianki blog)
- [Tofugu's jpdb.io Review](https://www.tofugu.com/japanese-learning-resources-database/jpdb-io/)
