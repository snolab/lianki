# Lianki

**Turn any webpage into a flashcard you'll actually remember.**

Lianki is a spaced repetition learning system that helps you retain what you read online. Instead of bookmarking pages you'll never revisit, Lianki schedules them for review using the scientifically-proven FSRS algorithm — showing you content right before you'd forget it.

🌐 **Try it now:** [www.lianki.com](https://www.lianki.com)

## What is Spaced Repetition?

Spaced repetition is a learning technique where you review information at increasing intervals. When you remember something easily, Lianki shows it to you less often. When you struggle, it comes back sooner. This builds long-term memory with minimal effort.

Apps like Anki have proven this works — but Lianki removes the friction. No card creation, no formatting, no templates. The webpage itself is the card.

## Features

- **One-Click Card Creation** — Press `Alt+F` on any page to add it to your review queue
- **FSRS Algorithm** — Modern spaced repetition (better than SM-2/Anki's old algorithm)
- **Inline Reviews** — Review cards without leaving your current page
- **Keyboard-Driven** — Rate your recall with `1-4`, navigate with `HJKL` or `ASDT`
- **Automatic Scheduling** — Cards appear when you're about to forget them
- **Cross-Device Sync** — Sign in with Google, GitHub, or email
- **GitHub-Style Heatmap** — Track your daily review streaks
- **Multilingual** — English, Chinese, Japanese support

## How It Works

### 1. Install the Userscript

Lianki uses a browser userscript (Tampermonkey/Violentmonkey) to add a floating button on every page you visit.

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Safari) or [Violentmonkey](https://violentmonkey.github.io/) (Firefox/Chrome)
2. Visit [lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js) to install the script
3. You'll see a small Lianki button on every webpage

### 2. Add Cards

**Add current page:**
- Press `Alt+F` OR click the Lianki button
- Lianki saves the URL and page title automatically

**Bulk add multiple URLs:**
1. Copy URLs (one per line)
2. Press `Alt+Shift+V`
3. Lianki creates a card for each URL

### 3. Review Cards

1. Visit [lianki.com](https://www.lianki.com) and click "Next card"
2. Read/watch the content again
3. Rate your recall:
   - **`1` (Again)** — Forgot it completely
   - **`2` (Hard)** — Remembered with difficulty
   - **`3` (Good)** — Remembered correctly
   - **`4` (Easy)** — Too easy, knew it cold
   - **`5` (Delete)** — Remove this card

FSRS calculates the optimal next review time based on your rating. Rate something "Easy" and you won't see it again for weeks. Rate it "Again" and it comes back tomorrow.

### Keyboard Shortcuts

**During Review:**
- `1-4` — Rate recall (Again/Hard/Good/Easy)
- `5` — Delete card
- `HJKL` — Vim-style navigation (Easy/Good/Again/Delete)
- `ASDT` — Alternative navigation (Easy/Good/Again/Delete)

**Video Speed Control (via Media Keys):**
- `Next Track` — Speed up playback + mark as easier
- `Previous Track` — Rewind 3s + slow down playback

**Adding Cards:**
- `Alt+F` — Add current page
- `Alt+V` — Add URL from clipboard
- `Alt+Shift+V` — Bulk add multiple URLs

## Who Is This For?

- **Language learners** — Loop through articles, videos, and lessons until vocabulary sticks
- **Developers** — Keep documentation, blog posts, and tutorials fresh in memory
- **Students** — Review lecture notes, papers, and reading assignments systematically
- **Researchers** — Retain key papers and resources over time
- **Anyone tired of Anki's friction** — No manual card creation, just save the link

## Example Workflow: Learning Japanese with jpdb.io

1. Add `jpdb.io/review` as a Lianki card
2. Add anime episodes, manga chapters, or articles as separate cards
3. Lianki schedules both vocabulary reviews (jpdb) and content (anime/manga)
4. Watch an episode → review it in Lianki → study new words on jpdb
5. Next time the episode comes up, you'll know more vocabulary

The content gets easier with each loop. See the full workflow in our [blog post](https://www.lianki.com/en/blog/2025-02-20-jpdb-lianki-workflow).

## FAQ

**Q: How is this different from Anki?**
A: Lianki is optimized for reviewing web content (articles, videos, manga readers), not isolated facts. No card creation needed — one hotkey saves any page. Anki excels at drilling individual words/concepts; Lianki excels at looping through materials that teach you those concepts.

**Q: What algorithm does Lianki use?**
A: FSRS (Free Spaced Repetition System), the same modern algorithm used by Anki's latest versions. It's more accurate than the old SM-2 algorithm from the 1980s. Read more in our [FSRS algorithm blog post](https://www.lianki.com/en/blog/2025-01-15-fsrs-algorithm).

**Q: Does it work offline?**
A: No. Lianki requires an internet connection to sync cards and reviews.

**Q: Is it free?**
A: Yes, Lianki is free to use.

**Q: Can I export my cards?**
A: Not yet, but export functionality is planned.

## Learn More

📝 **Blog Posts:**
- [What is Lianki?](https://www.lianki.com/en/blog/2025-01-01-introduction)
- [How FSRS Schedules Your Reviews](https://www.lianki.com/en/blog/2025-01-15-fsrs-algorithm)
- [Japanese Learning Workflow with jpdb.io](https://www.lianki.com/en/blog/2025-02-20-jpdb-lianki-workflow)

🛠️ **For Developers:**
See [DEVELOPMENT.md](./DEVELOPMENT.md) for technical documentation, API routes, and contribution guidelines.

## Author

snomiao <snomiao@gmail.com>

## License

MIT
