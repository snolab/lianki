---
title: "Deploying Lianki: Vercel + GitHub Actions"
date: 2025-02-15
tags: [deployment, vercel, github-actions, ci-cd]
summary: "How Lianki's CI/CD pipeline works: two branches, two environments, and a simple GitHub Actions workflow."
---

# Deploying Lianki: Vercel + GitHub Actions

Lianki runs on Vercel with a two-branch setup: `main` goes to production, `beta` goes to a preview environment. Deployments are triggered by GitHub Actions rather than Vercel's built-in Git integration, which gives more control over the build process.

## Branch Strategy

| Branch | URL                     | Purpose           |
| ------ | ----------------------- | ----------------- |
| `main` | https://www.lianki.com  | Production        |
| `beta` | https://beta.lianki.com | Staging / preview |

Feature work happens on topic branches, merged into `beta` for testing, then into `main` for release. The old domain `fsrsnext.snomiao.com` sends 308 redirects to `www.lianki.com` — kept alive for existing links.

## GitHub Actions Workflow

The deploy workflow lives at `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Vercel

on:
  push:
    branches: [main, beta]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Vercel CLI
        run: npm install -g vercel@latest

      - name: Pull Vercel Environment
        run: vercel pull --yes --environment=${{ github.ref_name == 'main' && 'production' || 'preview' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Build
        run: vercel build ${{ github.ref_name == 'main' && '--prod' || '' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Deploy
        run: vercel deploy --prebuilt ${{ github.ref_name == 'main' && '--prod' || '' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

The `github.ref_name == 'main' && '--prod' || ''` ternary makes `main` push a production deployment and `beta` push a preview. Three required GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

## Why Custom Actions Instead of Vercel's Git Integration

Vercel's built-in GitHub integration works well for simple projects but has a limitation: it runs builds on Vercel's infrastructure with no hook into the CI process. Using GitHub Actions instead means:

- Pre-deploy checks (lint, type check) run in the same pipeline before the build
- The `vercel pull` step fetches environment variables from Vercel's vault, so secrets aren't duplicated in GitHub
- Build logs are in one place (GitHub Actions) rather than split between GitHub and Vercel

## Vercel Project Setup

The Vercel project is named `lianki`. The project ID and org ID are stored as `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID` GitHub secrets — referenced by the deploy workflow but not hardcoded anywhere.

DNS is managed through Cloudflare (`lia.ns.cloudflare.com`, `roan.ns.cloudflare.com`). Cloudflare sits in front of Vercel for `lianki.com`.

## Pre-commit Hooks

Every commit runs through Husky:

```sh
# .husky/pre-commit
bun fix          # oxlint --fix + oxfmt
bun run typecheck  # tsgo --noEmit via @typescript/native-preview
```

`bun fix` runs `oxlint` (linting) and `oxfmt` (formatting). `tsgo --noEmit` is the TypeScript type checker from `@typescript/native-preview`, which is significantly faster than `tsc` for large codebases.

The `packages/` directory is excluded from both lint and format — it contains a git submodule (`pardon-could-you-say-it-again`) and touching those files would dirty the submodule.

## Environment Variables

Vercel stores the environment variables for both environments. The `vercel pull` step in CI fetches the appropriate set (production or preview) and writes them to `.vercel/output/`. They never need to be duplicated in GitHub Actions secrets.

The only secrets that live in GitHub are the Vercel credentials themselves (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`).

For local development, a `.env.local` file is used (not committed):

```env
MONGODB_URI=mongodb://localhost:27017/lianki
AUTH_SECRET=dev-secret-change-me
EMAIL_SERVER=smtp://localhost:1025
EMAIL_FROM=dev@localhost
```

## .vercelignore

A `.vercelignore` file keeps the deploy bundle small:

```
archived/
packages/
.husky/
*.md
```

The `packages/` submodule doesn't need to be deployed — its code is imported at build time and bundled into the output.

## Claude Code Action

The repo also has a GitHub Actions workflow for Claude Code (`.github/workflows/claude.yml`). Mentioning `@claude` in any issue or PR comment triggers Claude to respond, read the codebase, and propose or apply changes. This uses `anthropics/claude-code-action@beta` with `ANTHROPIC_API_KEY` stored as a GitHub secret.
