# Blog — Claude Notes

## Purpose

This folder contains blog posts about the Lianki project. Posts are written in Markdown and describe the technical and product decisions behind building Lianki — a spaced repetition app using the FSRS algorithm.

## Audience

- Developers interested in Next.js, MongoDB, and TypeScript
- People curious about spaced repetition and the FSRS algorithm
- Potential Lianki users wanting to understand how it works
- Open source contributors

## Style Guide

- Write in first person, conversational but technically accurate
- Include code snippets where they illustrate a point
- No marketing fluff — be honest about tradeoffs and design decisions
- Use concrete numbers and examples
- Keep posts focused on one topic each

## Directory Structure

```
blog/
  CLAUDE.md          — this file
  en/                — English posts
  cn/                — Chinese posts (同 slug，中文内容)
```

Each language folder uses the same filenames. When adding a new post, create it in both `en/` and `cn/`.

## File Naming

`YYYY-MM-DD-slug.md` — e.g. `2025-01-01-introduction.md`

## Frontmatter

Each post should start with:

```markdown
---
title: "Post Title"
date: YYYY-MM-DD
tags: [tag1, tag2]
summary: "One sentence description."
---
```

## Post Index

| Slug | Topic |
| ---- | ----- |
| `2025-01-01-introduction.md` | What Lianki is and why it exists |
| `2025-01-15-fsrs-algorithm.md` | How the FSRS scheduling algorithm works |
| `2025-02-01-architecture.md` | Next.js 16 + MongoDB stack walkthrough |
| `2025-02-10-userscript.md` | The Tampermonkey userscript and browser integration |
| `2025-02-15-deployment.md` | Vercel + GitHub Actions CI/CD setup |

## Project Facts (keep accurate)

- Production: https://www.lianki.com
- Beta: https://beta.lianki.com
- Repo: https://github.com/snomiao/lianki
- Stack: Next.js 16, React 19, TypeScript, MongoDB, NextAuth.js v5, Tailwind CSS
- Package manager: Bun
- Algorithm: FSRS via `ts-fsrs` library
- Auth: Email magic link, GitHub OAuth, Google OAuth
- Userscript: Tampermonkey/Violentmonkey, version 2.3.1, `Alt+F` shortcut
- Renamed from FSRSNext → Lianki
