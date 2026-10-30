# Secrets backup plan (proposal, 2026-10-31)

Status: **proposal, waiting for the owner's approval.** Nothing has been moved,
encrypted or rotated yet. This file names secrets only; it never holds a value.

Goal (owner, 2026-10-31 01:04 JST): keep a copy of every secret Lianki depends
on in the owner's encrypted env repo, so a lost Mac or a deleted Worker secret
is a restore, not an outage.

## 1. Where the backup goes

The owner's encrypted env repo is **`snomiao/.env.enc`**, encrypted with
[dede](https://github.com/snomiao/dotenvdotenc). dede is a thin wrapper over
dotenvx: each plaintext `.env.x` has an encrypted twin `.env.x.enc` (ECIES,
secp256k1 + AES-256-GCM per value). The repo uses the same layout as its
siblings `snomiao/.env.payments.enc` and `snomiao/.env.2fa.enc`:

- an allowlist `.gitignore` (`*`, then `!.env*.enc`, README, package files,
  `docs/`);
- a husky pre-commit that runs `dede guard`;
- plaintext files and `.env.keys` stay only on the owner's Mac, at mode 0600.

Proposed files, all encrypted with **one** new master key
(`dede enc <file> --key LIANKI`, the same pattern as `--key PAYMENTS`):

| file (plaintext, never committed) | committed as             | holds                                                                              |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `.env.lianki.worker`              | `.env.lianki.worker.enc` | secrets of the `lianki` Worker (and lianki-push once it has any)                   |
| `.env.lianki.ci`                  | `.env.lianki.ci.enc`     | GitHub Actions secrets of `snolab/lianki`                                          |
| `.env.lianki.dev`                 | `.env.lianki.dev.enc`    | local dev: `.dev.vars`, `.env.local`, `PROGRESS_TOKEN`, the dev-bridge secret (§5) |
| `.env.lianki.vercel`              | `.env.lianki.vercel.enc` | a one-time snapshot of the Vercel env (§4), kept as an archive                     |

**Not** in `snolab/lianki`: that repo is public. Add `*.enc` and `.env.keys` to
its `.gitignore` so an encrypted file can never be committed there by mistake
(today `.env*.local` does not match `.env.local.enc`).

## 2. The master key

`DOTENV_PRIVATE_KEY_LIANKI` is the one secret that protects all the others.
It is never committed to any repo, including the encrypted one.

- **Working copy**: `.env.keys` in the owner's checkout of `snomiao/.env.enc`
  (mode 0600, gitignored). Agents on the Mac use it through
  `dede get NAME | wrangler secret put NAME`, so values travel through a pipe
  and never reach a terminal, a log or Slack.
- **Backup 1**: the owner's password manager. No `op` / `bw` CLI is installed on
  the Mac, so the proposed default is Apple Passwords (iCloud Keychain,
  end-to-end encrypted; turn on Advanced Data Protection if it is not on). The
  owner pastes the line himself: no agent writes it.
- **Backup 2**: offline: printed or written down, kept with other recovery
  codes. Covers losing the Apple account as well as the Mac.
- Do the same for the keys that already exist and are only on this Mac today:
  `DOTENV_PRIVATE_KEY_PAYMENTS`, the 2FA repo's key and the `.env.enc` repo's
  key. dede's README says it plainly: the generated key "is the only copy".

**Recovery if the Mac dies**

1. New Mac: sign in to iCloud, open Passwords, copy the key lines.
2. `gh repo clone snomiao/.env.enc`, `umask 077`, write the lines to `.env.keys`.
3. `bun install` (installs dede and the guard hook), `bunx dede dec`,
   `bunx dede status` must report every file in sync.
4. Lianki checkout: copy the `.env.lianki.dev` values into `.dev.vars` (a small
   `scripts/dev/secrets-restore.ts` will do this; names only in its source).
5. Worker or CI secret lost: `bunx dede get NAME .env.lianki.worker.enc | bunx wrangler secret put NAME`
   (or `gh secret set NAME -R snolab/lianki` the same way).

A recovery drill (step 8 below) runs this in a scratch directory once, so the
procedure is known to work before it is needed.

## 3. The pre-commit secret scans

Lianki's hooks are unchanged: lint-staged runs secretlint on every staged file,
and CI runs gitleaks over the whole history (`.gitleaks.toml`). They never see
the encrypted files, because those live in another repo, so they keep catching
plaintext exactly as they do now.

In `snomiao/.env.enc`, `dede guard` is the scan. It blocks:

- a new plaintext `.env*` file;
- `.env.keys` itself, or any `DOTENV_PRIVATE_KEY…=<64 hex>` line;
- an `.enc` value that is not `encrypted:…`;
- a plaintext file whose edits are not yet encrypted.

Its blind spot is comments: dede commits comments in plaintext. It refuses the
obvious cases (`# OLD_TOKEN=…`, URLs with a password), so put no notes with
values in comments.

If gitleaks is ever added to the encrypted repo, its generic high-entropy rule
will flag the `encrypted:…` values and the `DOTENV_PUBLIC_KEY` header, which is
public by design. Allowlist exactly those two patterns, for `.env*.enc` paths
only. A plaintext value is then still caught.

## 4. Inventory (names only, read 2026-10-31)

"Readable" means the value can still be read back somewhere today.
Worker and Actions secrets are write-only: once set, nobody can read them back.

### `lianki` Worker (`wrangler secret list`): 13

| name                                        | if lost                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`, `BETTER_AUTH_SECRET`         | **unrecoverable.** Exists on the Worker and probably in Vercel's env (the cutover copied Vercel's env). A new value signs every user out. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`      | ID readable in GitHub's OAuth app page; secret: issue a new one                                                                           |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`      | readable in Google Cloud Console (shared with fsrsnext)                                                                                   |
| `RESEND_API_KEY`                            | issue a new one in Resend                                                                                                                 |
| `CLOUDFLARE_AI_TOKEN`                       | issue a new one in Cloudflare                                                                                                             |
| `SLACK_SIGNING_SECRET`, `SLACK_WEBHOOK_URL` | readable in the Slack app config                                                                                                          |
| `TURNSTILE_SECRET_KEY`                      | readable in the Cloudflare dashboard                                                                                                      |
| `EMAIL_FROM`, `CLOUDFLARE_ACCOUNT_ID`       | not secret                                                                                                                                |

`lianki-push`, `lianki-monitor`, `lianki-voice`: **no secrets set.** Notably
`PROGRESS_TOKEN` is not set on lianki-push, so live-progress writes answer 503
today. Generate it during this work and store it in `.env.lianki.dev`.

Read by the code but **not on the Worker** (so either unused in production,
only in Vercel, or off): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (payments
are off until set, see [payments.md](payments.md)),
`GITHUB_SPONSORS_WEBHOOK_SECRET`, `YOUTUBE_API_KEY`, `GITHUB_INTL_TOKEN`,
`SLACK_BOT_EMAIL`; `OPENAI_API_KEY` is in the cutover list but replaced by
Workers AI. Step 3 tells which of these exist in Vercel.

### GitHub Actions (`snolab/lianki`)

Secrets: `CLAUDE_CODE_OAUTH_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`, `MONGODB_URI`, `NEON_API_KEY`, `NPM_TOKEN`. All are
write-only, and all can be issued again at their provider (Atlas password reset
for `MONGODB_URI`). Variables (not secret, readable): `NEON_PROJECT_ID`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`. The deployment environments hold no secrets.

### Vercel

**Not yet listed:** the Vercel CLI on the Mac is logged out. Vercel is the only
place where some values may still be readable (an env var not marked
"Sensitive" can be pulled with `vercel env pull`). That likely includes the
`AUTH_SECRET` the Worker was given, plus the Vercel-only names above. **Take
this snapshot before anything is deleted from Vercel.**

### Local files

- `.dev.vars` in `main` and in 12 other worktrees: `AUTH_SECRET`,
  `BETTER_AUTH_BASE_URL`, `DB_BACKEND`, `DEV_EMAIL_PASSWORD_AUTH`, `NODE_ENV`:
  **dev-only** values (`qa:all` creates the file from `.dev.vars.example`).
  Recoverable: regenerate.
- `.env.local`: none in `main`. Two worktrees have one, with the same names as
  `.env.local.example`: dev `AUTH_SECRET`, local `MONGODB_URI`,
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public). One of them is byte-identical to
  the example. Recoverable.
- `.rechrome/.env.local`: `RECHROME_URL` (tool config).

So the AGENTS.md line "unrecoverable" is about the _pattern_ (a gitignored file
with no other copy), not about anything irreplaceable in today's files. The
values that really cannot be recovered are on the Worker (`AUTH_SECRET`,
`BETTER_AUTH_SECRET`) and possibly in Vercel.

### Rule change in AGENTS.md (applied once step 7 lands)

> `.env.local` and `.dev.vars` are gitignored — never delete them. They are
> backed up encrypted in `snomiao/.env.enc` (`.env.lianki.dev.enc`); restore with
> `bun scripts/dev/secrets-restore.ts`. Never commit `*.enc` or `.env.keys` here:
> this repo is public.

Until then this PR only points the existing line at this plan.

## 5. Public or private repo

`snomiao/.env.enc` is **PRIVATE** (checked with `gh repo view`), like
`.env.payments.enc` and `.env.2fa.enc`. `snolab/lianki` is **PUBLIC**.

Keep the backup private. Encrypted-but-public would rely on the key alone:

- git history is forever, so one leaked `.env.keys` (a backup, a screenshot, a
  stray agent log) exposes every value ever committed, with no way to take the
  ciphertext back;
- "harvest now, decrypt later": anyone can copy the ciphertext today and wait for
  a key leak or a broken algorithm;
- file names, key names and commit times are public even without the key.

Private adds GitHub access control as a second lock, at no cost. Recommendation:
private, no collaborators (none today besides the owner).

## 6. The dev-server bridge, and leaving Vercel

**Bridge.** Option A copied the production `AUTH_SECRET` to the Mac, so a local
dev server could accept production sessions. With this backup that becomes easy
to do, but it is still the wrong design: anything on the Mac that can read it can
forge a session for _any_ user, and the only fix after a leak signs everyone
out. **Option B**: a separate `DEV_BRIDGE_SECRET`, generated new, set on the
Worker and in `.env.lianki.dev`, accepted only by the bridge endpoints and only
for owner accounts. It can be rotated alone without touching user sessions. The
encrypted repo is what keeps it in sync between the Worker and the Mac's
worktrees. Recommendation: B; build it in its own PR.

**Everything on Cloudflare.** Runtime secrets are already on the Worker; after
the Vercel snapshot, any Vercel-only value still needed moves to
`wrangler secret put`, and the rest are dropped. The env vars can then be
deleted from Vercel. The **project cannot be deleted**: per AGENTS.md it serves
the `fsrsnext.snomiao.com` and `fsrsnext.vercel.app` → `lianki.com` redirects.
`snomiao.com` is on Cloudflare DNS, so `fsrsnext.snomiao.com` could become a
Cloudflare redirect rule, but `fsrsnext.vercel.app` can only be answered by
Vercel. So the end state is a Vercel project with no secrets and no builds, kept
only for that redirect, unless the owner accepts losing it.

## 7. Steps

| #   | step                                                                                                                                                                | who                                 | agent hours          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| 1   | approve this plan and the decisions below                                                                                                                           | owner                               | —                    |
| 2   | create the four `.env.lianki.*` files with key `LIANKI`; add `*.enc` / `.env.keys` to lianki's `.gitignore`                                                         | agent                               | 0.3                  |
| 3   | `vercel login` (owner approves the login), then `vercel env pull` per environment into `.env.lianki.vercel`, encrypt                                                | owner + agent                       | 0.3                  |
| 4   | fill the Worker and CI files: values from the Vercel snapshot, else read from the provider dashboard (rechrome), else re-issue and set the new value in both places | agent; owner approves each re-issue | 1.5                  |
| 5   | set `PROGRESS_TOKEN` on lianki-push and in `.env.lianki.dev`                                                                                                        | agent                               | 0.2                  |
| 6   | back up `DOTENV_PRIVATE_KEY_LIANKI` and the three existing master keys: password manager + offline                                                                  | owner                               | ~5 min of owner time |
| 7   | `scripts/dev/secrets-restore.ts`, the AGENTS.md / secrets-and-auth.md rule change (§4)                                                                              | agent                               | 0.5                  |
| 8   | recovery drill in a scratch directory: clone, key from backup, `dede dec`, `dede status`                                                                            | agent                               | 0.3                  |
| 9   | delete Vercel env vars once 3–4 are verified (project and domains stay)                                                                                             | agent; owner approves               | 0.2                  |
| 10  | `DEV_BRIDGE_SECRET` (option B), its own PR                                                                                                                          | agent                               | 1.5                  |

Total: about **4.8 agent hours**, plus three owner actions (step 3 login,
step 6 key backup, approvals).

## Decisions for the owner

1. **Repo**: put the files in `snomiao/.env.enc` (as asked), or in a new private
   `snomiao/.env.lianki.enc` like the payments split? Default: `snomiao/.env.enc`.
2. **Key**: one master key `LIANKI` for all four files? Default: yes.
3. **Key backup**: Apple Passwords plus an offline copy? Default: yes, done by
   the owner.
4. **Visibility**: keep it private. Default: yes.
5. **Secrets that cannot be read back** (`AUTH_SECRET`, `BETTER_AUTH_SECRET` if
   Vercel has no readable copy): leave them on the Worker un-backed-up, or
   rotate (signs everyone out once)? Default: leave them.
6. **Re-issue** write-only provider secrets (GitHub/Resend/Cloudflare tokens) to
   get a copy? Default: yes, one at a time, each approved.
7. **Bridge**: option B (`DEV_BRIDGE_SECRET`), never prod `AUTH_SECRET` locally.
   Default: B.
8. **Vercel**: delete its env vars after the backup, keep the project for the
   fsrsnext redirects. Default: yes.
