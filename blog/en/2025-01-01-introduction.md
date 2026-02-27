---
title: "What is Lianki?"
date: 2025-01-01
tags: [lianki, spaced-repetition, introduction]
summary: "Lianki is a spaced repetition app that turns any webpage into a flashcard you'll actually remember."
---

# What is Lianki?

*Posted January 01, 2025 by [lianki.com](https://www.lianki.com)*

Lianki is a spaced repetition app. The name comes from 链接 (liànjiē) — Chinese for "link" — because the core idea is simple: you save a link, and Lianki schedules when you should revisit it so you actually remember what was on that page.

## The Problem

Most people use bookmarks or read-later apps like Pocket. These work fine for saving things. They don't help you remember them. Bookmarks become a graveyard. Pocket becomes a pile. You save things with good intentions and never look at them again.

Spaced repetition solves this. It shows you something right before you'd forget it, which builds long-term memory with far less effort than re-reading everything. Apps like Anki have proven this works. The problem with Anki is friction — you have to manually create cards, format them, keep them updated. It's a part-time job.

Lianki removes that friction. You're already browsing. You find something worth remembering. You press `Alt+F`, and Lianki adds the current URL to your review queue. That's it. No card creation, no formatting, no templates. The webpage itself is the card.

## How Reviews Work

Lianki uses the **FSRS algorithm** (Free Spaced Repetition System) to schedule reviews. When a card comes up, you click through to the original page, read it again, then rate yourself:

- **Again** — forgot it entirely
- **Hard** — remembered with difficulty
- **Good** — remembered correctly
- **Easy** — trivial, knew it cold

FSRS uses your rating to calculate the next review interval. Rate something "Easy" and you won't see it again for weeks. Rate it "Again" and it comes back tomorrow. Over time, each card finds its own natural rhythm based on how hard it is for you specifically.

## Who It's For

Lianki works best for:

- Language learners
- Developers keeping up with documentation, blog posts, or spec pages
- Researchers and students with a reading list they actually need to retain
- Anyone who's tried Anki and given up because card creation is too much work

## The Userscript

Lianki ships a Tampermonkey/Violentmonkey userscript that puts a floating button on every page you visit. Press `Alt+F` to add the current page, or click the button. Reviews happen inline — a small dialog pops up so you can rate your memory without leaving the page you're already on.

The userscript also normalizes URLs automatically. If you save a YouTube video from `youtu.be/xyz` on mobile and later encounter it at `youtube.com/watch?v=xyz` on desktop, Lianki treats them as the same card. Tracking parameters (`utm_*`, `fbclid`, etc.) are stripped so you don't accumulate duplicates.

## Get Started

Lianki is free at [www.lianki.com](https://www.lianki.com). Sign in with Google, GitHub, or email.

---

**License**: This work is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). You are free to share and adapt this content with attribution.
