# devbox — a dev container for a friend building their own Lianki frontend

Owner request, 2026-11-05 (Slack): a box on the owner's Mac where a friend
(first: `kishouzet`) works on **their own frontend** for Lianki and talks to
coding agents. One box per friend, one env var apart.

## What is inside

| Piece                                         | Notes                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Debian bookworm, Node 24, Bun, git, tmux      | `node:24-bookworm`; everything runs as `node` (uid 1000), never root                                      |
| Claude Code, Codex CLI                        | pinned in `Dockerfile` build args; the friend logs in with **their own** accounts                         |
| DeepSeek Harness (`dsh web`)                  | the main web UI, `127.0.0.1:3080` **inside** the box (see below)                                          |
| `~/lianki`                                    | anonymous clone of `snolab/lianki`, branch `friend/<name>`                                                |
| `next dev` on `:3000` → host `127.0.0.1:3200` | `DB_BACKEND=d1` on a **local Miniflare D1** (`.wrangler/state` in the volume), dev email+password sign-in |

Everything the friend keeps (clone, logins, dsh home, local D1) is in one
named volume, `lianki-devbox-<name>-home`, mounted at `/home/node`.

## Run it (on the owner's Mac)

```bash
cp devbox/.env.example devbox/.env            # DEVBOX_NAME=kishouzet
docker compose -f devbox/compose.yaml --env-file devbox/.env up -d --build
docker compose -f devbox/compose.yaml --env-file devbox/.env logs -f   # first run: clone, bun install, migrations
docker exec -it lianki-devbox-kishouzet bash  # a shell in the box (tmux available)
```

First start clones the repo, runs `bun install`, applies `db/migrations` to the
local D1, then `devbox-start` runs `next dev` and `dsh web`
(logs: `~/.devbox/logs/{dev,dsh}.log` in the box). The dev server answers on
`http://127.0.0.1:3200` on the Mac. Sign in with any email and password —
`DEV_EMAIL_PASSWORD_AUTH=1` makes the account in the local D1.

Plain Compose, nothing engine-specific: the Mac runs it on **Colima**
(`colima start devbox`, profile in `~/.colima/devbox`, VM mounts restricted to
an empty read-only directory). Why not OrbStack: its terms ask for a paid
licence for commercial use, and Lianki sells Pro passes. Docker Desktop works
the same (`docker context use desktop-linux`). Check where a build lands with
`docker context ls`.

### Reset

```bash
docker compose -f devbox/compose.yaml --env-file devbox/.env down        # stop, keep the volume
docker compose -f devbox/compose.yaml --env-file devbox/.env down -v     # ALSO deletes the friend's work and logins — ask first
docker compose -f devbox/compose.yaml --env-file devbox/.env build --pull --no-cache   # new tool versions
```

`down -v` throws away unpushed commits and the friend's Claude/Codex logins:
ask the friend before running it.

### Another friend

Each box is its own Compose project, container and volume, named after
`DEVBOX_NAME`. Use a second env file:

```bash
git push origin origin/main:refs/heads/friend/<name>       # the owner, once
cp devbox/.env.example devbox/.env.<name>                   # DEVBOX_NAME=<name>, DEVBOX_DEV_PORT=3201
docker compose -f devbox/compose.yaml --env-file devbox/.env.<name> up -d --build
```

In `devbox/.env.<name>` also set `DEVBOX_ENV_FILE=.env.<name>`, so the box
reads that friend's file (and its `DEEPSEEK_API_KEY`). `devbox/.env*` is
gitignored except `.env.example`.

## Security boundaries

- **No owner credential in the image or volume.** No GitHub token, no
  `.env.local`, no `.dev.vars`, no wrangler/Cloudflare login, no production
  secret. `.dockerignore` lets only the two scripts into the build context, so
  `devbox/.env` never reaches an image layer. The dev server's `AUTH_SECRET` is
  random, made in the box on first start (`~/.devbox/auth-secret`), and only
  signs local-D1 sessions.
- **No production data.** `wrangler.jsonc`'s D1 and R2 run locally under
  `next dev` (no `remote: true`, and the box has no Cloudflare login to reach
  anything remote). `LIANKI_DEV_WHOLE_PAGE` is never set here.
- **Container hardening.** Non-root, `cap_drop: ALL`, `no-new-privileges`,
  CPU/memory/pids limits (`DEVBOX_CPUS`, `DEVBOX_MEMORY`), no Docker socket, no
  host directory mounted, the only published port bound to `127.0.0.1`.
- **The one secret inside:** `DEEPSEEK_API_KEY` (below). Anyone with a shell in
  the box can read it — that is the friend, by design. Cap its spend.

## Git: the box cannot push

The clone is anonymous HTTPS, and `origin`'s push URL is set to an invalid
placeholder, so `git push origin` fails with a pointer here. The friend's
changes reach Lianki as pull requests **from their own GitHub fork**:

```bash
# in the box, with the friend's own GitHub account (their token, their choice):
gh auth login                       # or: git remote add fork https://github.com/<them>/lianki.git
git remote add fork https://github.com/<them>/lianki.git
git push fork friend/<name>
# then open a PR on GitHub: base snolab/lianki:friend/<name>, head <them>:friend/<name>
```

Without any login, an agent can still hand over work as patches:
`git format-patch origin/friend/<name>` → the owner applies them. The owner
merges the friend's PRs into `friend/<name>`; nothing goes to `main` from the
box.

## DeepSeek Harness (dsh)

`dsh web` serves its UI on `127.0.0.1:3080` inside the box and is **not
published**: it is a full shell into the container, so it stays unreachable
until Cloudflare Access is in front of it. It still has its own auth (a launch
token in the URL it prints, then a signed cookie), but that is not the gate.

Until then the friend works in a terminal (`docker exec -it
lianki-devbox-<name> bash`, then `claude`, `codex`, or `dsh --profile headless "…"`),
and `dsh web` runs only so it is ready.

**Key:** `DEEPSEEK_API_KEY`, provided by the owner, lives only in the
gitignored `devbox/.env` and is passed into the box by `env_file`. The owner
sets it himself, without it appearing anywhere else:

```bash
read -s K && printf 'DEEPSEEK_API_KEY=%s\n' "$K" >> ~/ws/snolab/lianki/tree/main/devbox/.env && unset K
docker compose -f devbox/compose.yaml --env-file devbox/.env up -d   # recreate to pick it up
```

Set a spend limit for that key in the DeepSeek console. dsh's OTel upload is
off (`DSH_TELEMETRY_MODE=DISABLED`); its DeepSeek session-log contribution is
on by default and is switched off in the web UI under **Settings → General →
Upload Session Log**.

## Tunnel (host side, nothing in the box)

The friend sees the dev server through a **named Cloudflare tunnel run on the
Mac** with the Mac's existing cloudflared login (`~/.cloudflared/cert.pem`,
as `lianki-preview` uses — docs/dev-whole-page.md). Its credentials JSON and
config stay in `~/.cloudflared` (0600); the repo holds only the script.

```bash
devbox/host-tunnel.sh create    # tunnel lianki-devbox-<name> + ~/.cloudflared/lianki-devbox-<name>.yml
OWNER_APPROVED_DNS=1 devbox/host-tunnel.sh dns    # CNAME devbox-<name>.lianki.com — owner's typed OK first
devbox/host-tunnel.sh run       # connector (foreground; run under oxmgr to keep it up)
devbox/host-tunnel.sh status
```

Ingress: `devbox-<name>.lianki.com → http://127.0.0.1:<DEVBOX_DEV_PORT>`,
everything else 404. After the DNS record exists, set
`DEVBOX_PUBLIC_URL=https://devbox-<name>.lianki.com` in `devbox/.env` and
recreate the box, so sign-in and `allowedDevOrigins` use that host. The dev
server holds only local data; the production-facing view of the friend's
frontend comes through Lianki's custom-frontend `?live` feature instead.

### dsh behind Cloudflare Access (pending the friend's email)

Not done until the owner gives the friend's email. Then:

1. Zero Trust → Access → Applications → self-hosted, `dsh-<name>.lianki.com`,
   policy **Allow, emails: <friend's email>** (plus the owner's).
2. In the box, bind dsh to the container's address and trust the host:
   `dsh web --host "$(hostname -i | awk '{print $1}')" --port 3080 --no-open --public-url https://dsh-<name>.lianki.com/ --trusted-host dsh-<name>.lianki.com`
   and publish `127.0.0.1:<3280+n>:3080` in `compose.yaml`.
3. Add `- hostname: dsh-<name>.lianki.com / service: http://127.0.0.1:<port>`
   to the tunnel config **above** the 404 rule, and its DNS record (owner's
   typed OK). Never route dsh before step 1 is live.
