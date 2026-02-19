# Blog — Claude Notes

## Purpose

This folder contains blog posts for Lianki users — explaining how to learn effectively, how spaced repetition works, and how to get the most out of Lianki. Written for normal users, not developers.

Developer and infrastructure docs (architecture, deployment, CI/CD) live in `docs/` instead.

## Audience

- Anyone learning a language, studying for exams, or building long-term knowledge
- New Lianki users wanting to understand how it works
- People curious about spaced repetition and why it's effective

## Style Guide

- Write for a general audience — assume no programming knowledge
- Conversational tone, explain jargon when it appears
- Focus on what the user gains, not how the code works
- Use concrete examples from real learning scenarios
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

| Slug                           | Topic                                       |
| ------------------------------ | ------------------------------------------- |
| `2025-01-01-introduction.md`   | What Lianki is and why it exists            |
| `2025-01-15-fsrs-algorithm.md` | How FSRS schedules your reviews             |
| `2025-02-10-userscript.md`     | Installing and using the browser userscript |

Dev/infra posts moved to `docs/`:

- `docs/en/2025-02-01-architecture.md` — Next.js 16 + MongoDB stack
- `docs/en/2025-02-15-deployment.md` — Vercel + GitHub Actions CI/CD

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
