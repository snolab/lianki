# Lianki — Claude Project Notes

## Project

Spaced repetition app (FSRS algorithm) built with Next.js 15. Renamed from FSRSNext → Lianki.

- Repo: https://github.com/snomiao/lianki
- Production: https://www.lianki.com (Vercel, `main` branch)
- Beta: https://beta.lianki.com (Vercel, `beta` branch, preview deployment)
- Old domain `fsrsnext.snomiao.com` → 308 redirects to `www.lianki.com`

## Stack

- **Framework**: Next.js 16 App Router (Turbopack), TypeScript
- **Package manager**: Bun
- **Database**: MongoDB (env: `MONGODB_URI`)
- **Auth**: NextAuth.js v5 — Email, GitHub, Google OAuth
- **UI**: Tailwind CSS (via `app/globals.css`)
- **Linting**: oxlint (`--ignore-pattern 'packages/**'`)
- **Formatting**: oxfmt (ignores `packages/` via `.prettierignore`)
- **Pre-commit**: Husky → `bun fix` (oxlint + oxfmt) + `bunx @typescript/native-preview --noEmit`

## Routing

- `/` — landing page (`app/page.tsx`)
- `/list` — note-listing app page (`app/list/page.tsx`)
- `/api/fsrs/*` — FSRS API endpoints
- `/api/auth/*` — NextAuth routes

## Deployment (Vercel)

- Project ID: `prj_BoWb5ZrwLrYVyAxGb8a5XOs7i7gu`
- Org ID: `team_0YVgkyqvak5X8lMl3zNBqIC7`
- DNS: Cloudflare nameservers (`lia.ns.cloudflare.com`, `roan.ns.cloudflare.com`)
- CI: `.github/workflows/deploy.yml` — `main` deploys `--prod`, `beta` deploys as preview
- Required GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`

## Packages / Submodules

- `packages/pardon-could-you-say-it-again` — git submodule from https://github.com/snomiao/pardon-could-you-say-it-again
- Workspaces: `packages/*` (bun workspaces)
- `packages/` is excluded from oxlint and oxfmt to avoid dirtying submodule content

## Key Files

| File                           | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `app/page.tsx`                 | Landing page                          |
| `app/list/page.tsx`            | Note listing (main app)               |
| `app/fsrs.ts`                  | Core FSRS handler logic               |
| `app/db.ts`                    | MongoDB client                        |
| `auth.ts` / `auth.config.ts`   | NextAuth setup                        |
| `public/lianki.user.js`        | Tampermonkey/Violentmonkey userscript |
| `.husky/pre-commit`            | Pre-commit hook                       |
| `.github/workflows/deploy.yml` | CI/CD to Vercel                       |

## Google OAuth

Credentials (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) are shared between `fsrsnext.snomiao.com` and `lianki.com`. Both domains need to be in the Google Cloud Console OAuth client's authorized origins and redirect URIs:

- `https://lianki.com/api/auth/callback/google`
- `https://www.lianki.com/api/auth/callback/google`

## Workflow Reminders

### PR Workflow (beta → main)

**Standard workflow for merging features:**

1. Develop on `beta` branch
2. Create PR to `main` and enable auto-merge:
   ```bash
   gh pr create --title "feat: description" --body "..." --base main
   gh pr merge <PR_NUMBER> --auto --squash
   ```
3. **ALWAYS rebase beta onto main after PR merges:**
   ```bash
   git fetch origin && git rebase origin/main
   git push -f origin beta
   ```

**Why auto-rebase after PR merge:**

- Keeps beta in sync with main
- Prevents conflicts on next PR
- Git automatically drops commits already in main (via squash merge)
- Ensures clean branch history

### After Every Push

**ALWAYS check CI/deployment status immediately after pushing:**

```bash
# Check GitHub Actions CI status
gh run list --branch main --limit 5

# Check Vercel deployment status
vercel ls | head -20

# Inspect failed deployment
vercel inspect <deployment-url>

# Check what's live in production
curl -s https://www.lianki.com/lianki.user.js | grep '@version'
```

**Common failure modes:**

- Vercel build fails (check logs with `vercel logs <url>`)
- Edge runtime incompatibility (e.g., Node.js `crypto` module not available)
- TypeScript errors (enable type checking in build)
- Missing environment variables

**If deployment fails:**

1. Check build logs via Vercel dashboard or CLI
2. Fix the issue locally
3. Test build with `bun run build`
4. Push fix and verify deployment succeeds

### QA Process — ALWAYS do this after deploying

**After every deployment, QA using both remote Chrome AND Vercel logs together:**

1. **Navigate in remote Chrome** to the affected page(s):
   ```
   browser_navigate → https://www.lianki.com/<path>
   browser_snapshot → check for errors / error boundaries
   ```

2. **Stream Vercel logs in background** while triggering requests:
   ```bash
   vercel logs https://www.lianki.com 2>&1 | head -80
   # Run in background so Chrome can trigger requests simultaneously
   ```

3. **Correlate digest → real error**: Production Next.js hides error messages — only a digest is shown in the UI. The real error message appears in Vercel runtime logs. Match the digest in the log output to confirm the root cause.

4. **If still failing after a fix**: The digest will change between deployments if the error changed. A repeated digest means the same error persists (not a CDN issue — deploy is live).

**Example QA flow:**
```
browser_navigate /ja/list
→ sees "Digest: 2183905591"

vercel logs https://www.lianki.com
→ "[Lianki] Cards error: TypeError: Expected a positive number"
→ digest: '2183905591'  ← confirms match

→ fix dueMs() to handle negative diff
→ redeploy → browser_navigate again → page loads ✅
```

## Claude Working Habits

### Task Management

**ALWAYS use TodoWrite tool:**
- Start complex tasks by creating a todo list
- Update status: pending → in_progress → completed
- Mark tasks completed IMMEDIATELY after finishing
- Keep exactly ONE task as in_progress at a time

**Example workflow:**
```
1. TodoWrite: Create initial task list
2. Start first task, mark as in_progress
3. Complete task, mark as completed
4. Move to next task
```

### Development Process

**Before making changes:**
1. Read files before editing (never edit blindly)
2. Check for existing implementations (Glob/Grep)
3. Explore with Task tool for complex searches
4. Test build locally: `bun run build`

**When committing:**
1. Test build first: `bun run build`
2. Use `git add -A && git commit --no-verify` if linting fails on unrelated files
3. Include descriptive commit message with:
   - What changed
   - Why it changed
   - Implementation details
   - `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`

**Example commit:**
```bash
git commit --no-verify -m "$(cat <<'EOF'
feat: add guest mode with local IndexedDB storage

Enable full offline functionality for guest users.
- Made auth optional in /list page
- Created GuestListClient using idb package
- Shows sync status: localcount/syncedcount

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

### PR Best Practices

**Creating PRs:**
1. Create descriptive PR title: `feat:`, `fix:`, `docs:`
2. Include detailed PR body with:
   - Summary section
   - Features/changes list with emojis
   - Implementation details
   - Benefits
   - Screenshots/examples if relevant
   - Footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
3. Enable auto-merge immediately: `gh pr merge <PR> --auto --squash`

**After PR merges:**
```bash
# ALWAYS rebase beta onto main
git fetch origin && git rebase origin/main
git push -f origin beta
```

### Incremental Development

**For large features, create staged PRs:**
1. PR #1: Core functionality (basic working version)
2. PR #2: UI improvements
3. PR #3: Advanced features
4. Each PR should be independently deployable

**Benefits:**
- Faster review cycles
- Easier to debug issues
- Progressive enhancement
- Clear feature evolution

### Code Quality

**TypeScript:**
- Use `any` sparingly, prefer proper types
- Import types from dependencies when available
- Use `type` instead of `interface` for consistency

**Error Handling:**
- Wrap auth calls in try/catch for optional login
- Log errors to console with `[Lianki]` prefix
- Show user-friendly error messages

**Performance:**
- Use parallel tool calls when operations are independent
- Prefer client-side rendering for interactive components
- Use Suspense for async server components

### Communication

**With user:**
- Be concise and clear
- Show what was accomplished (✅ lists)
- Include relevant URLs (PR links, deployment URLs)
- Use emojis sparingly unless user requests

**In code:**
- Add comments only when logic isn't self-evident
- Document complex algorithms or workarounds
- Link to relevant docs/issues in comments
