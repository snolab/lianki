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
devbox/box.sh up -d --build                   # = docker --context orbstack compose … up
devbox/box.sh logs -f                         # first run: clone, bun install, migrations
devbox/box.sh exec box bash                   # a shell in the box (tmux available)
```

First start clones the repo, runs `bun install`, applies `db/migrations` to the
local D1, then `devbox-start` runs `next dev` and `dsh web`
(logs: `~/.devbox/logs/{dev,dsh}.log` in the box). The dev server answers on
`http://127.0.0.1:3200` on the Mac. Sign in with any email and password —
`DEV_EMAIL_PASSWORD_AUTH=1` makes the account in the local D1.

**Engine: OrbStack, always named explicitly.** Docker Desktop on this Mac runs
another project (symtak): never touch it, its containers, images, volumes or
context. `devbox/box.sh` runs `docker --context orbstack compose` with
`DOCKER_CONTEXT=orbstack`, so it never uses the default socket; use it, or pass
`--context orbstack` to any `docker` command by hand. The compose file itself
is plain Compose. Licence: OrbStack is free for personal use only and asks for
a paid licence for "freelance, business, and commercial use". Lianki sells Pro
passes, so this is still open: the owner preferred OrbStack on 2026-11-05 and
was told about the terms in Slack afterwards; no licence decision is recorded.

### Reset

```bash
devbox/box.sh down                        # stop, keep the volume
devbox/box.sh down -v                     # ALSO deletes the friend's work and logins — ask first
devbox/box.sh build --pull --no-cache     # new tool versions
```

`down -v` throws away unpushed commits and the friend's Claude/Codex logins:
ask the friend before running it.

### Another friend

Each box is its own Compose project, container and volume, named after
`DEVBOX_NAME`. Use a second env file:

```bash
git push origin origin/main:refs/heads/friend/<name>       # the owner, once
cp devbox/.env.example devbox/.env.<name>                   # DEVBOX_NAME, DEVBOX_ENV_FILE=.env.<name>, next free ports
DEVBOX_ENV=.env.<name> devbox/box.sh up -d --build
DEVBOX_ENV=.env.<name> devbox/host-tunnel.sh create
```

`DEVBOX_ENV_FILE=.env.<name>` makes the box read that file (and its
`DEEPSEEK_API_KEY`). `devbox/.env*` is gitignored except `.env.example`.

Boxes on the owner's Mac (2026-11-05):

| Box         | Env file              | Dev server (host loopback → public)           | dsh port | Branch             |
| ----------- | --------------------- | --------------------------------------------- | -------- | ------------------ |
| `kishouzet` | `devbox/.env`         | `127.0.0.1:3200` → its `my-<hash>.lianki.com` | 3280     | `friend/kishouzet` |
| `snomiao`   | `devbox/.env.snomiao` | `127.0.0.1:3201` → its `my-<hash>.lianki.com` | 3281     | `friend/snomiao`   |

The owner's own box (`snomiao`) is for trying the setup before the friend.

### Signing in through lianki.com

Set `DEVBOX_LIANKI_CLIENT_ID` in the box's env file, from `/dev/box-clients`, and
the box's own sign-in and sign-up are gone: it signs in through lianki.com as one
bound account and calls the production API with a short-lived token. Dark behind
the flag `box.oauth`; leave the variable empty until that is on, or the box cannot
sign in at all. [docs/box-oauth.md](../docs/box-oauth.md).

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
  host directory mounted, both published ports bound to `127.0.0.1`.
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

`dsh web` serves its UI on `127.0.0.1:3080` inside the box: it is a full
shell into the container, so it stays unreachable until Cloudflare Access is
in front of it. Compose forwards `127.0.0.1:<DEVBOX_DSH_PORT>` on the host to
the box's `:3080`, but while dsh listens on the box's own loopback that
forward reaches nothing. It still has its own auth (a launch
token in the URL it prints, then a signed cookie), but that is not the gate.

Until then the friend works in a terminal (`devbox/box.sh exec
box bash`, then `claude`, `codex`, or `dsh --profile headless "…"`),
and `dsh web` runs only so it is ready.

**Key:** `DEEPSEEK_API_KEY`, provided by the owner, lives only in the
gitignored box env file and is passed into the box by `env_file`. The owner
sets it himself, without it appearing anywhere else:

```bash
read -s K && printf 'DEEPSEEK_API_KEY=%s\n' "$K" >> ~/ws/snolab/lianki/tree/main/devbox/.env && unset K
devbox/box.sh up -d   # recreate to pick it up
# his own box: the same with devbox/.env.snomiao and DEVBOX_ENV=.env.snomiao devbox/box.sh up -d
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
OWNER_APPROVED_DNS=1 devbox/host-tunnel.sh dns    # CNAME my-<hash>.lianki.com — owner's typed OK first
devbox/host-tunnel.sh status
# connector, kept up by oxmgr (as lianki-preview-tunnel is):
oxmgr start --name lianki-devbox-<name>-tunnel --restart always --cwd ~ \
  "$HOME/.local/bin/cloudflared tunnel --no-autoupdate --config $HOME/.cloudflared/lianki-devbox-<name>.yml run lianki-devbox-<name>"
```

Each command takes `DEVBOX_ENV=.env.<name>` for another box. Connectors
`lianki-devbox-{kishouzet,snomiao}-tunnel` run under oxmgr.

**Public hosts are `my-<hash>.lianki.com`** (owner, 2026-11-05): one level, so
the free certificate covers them, and unguessable. Each box has its own random
hash (`openssl rand -hex 8`), kept only in that box's gitignored env file
(`DEVBOX_PUBLIC_URL`) and its tunnel config in `~/.cloudflared`. Never write one
in the repo; `host-tunnel.sh` reads it from the env file and refuses without it.
The hash hides the URL but is not a login: anyone who has it can open the page.

The first records, `devbox-kishouzet` and `devbox-snomiao`, are out of the
ingress (they answer 404) and are still to be deleted: neither cloudflared nor
wrangler's OAuth can delete a DNS record, so that needs an API token with
Zone · DNS · Edit.

Ingress: `my-<hash>.lianki.com → http://127.0.0.1:<DEVBOX_DEV_PORT>`,
everything else 404. Set `DEVBOX_PUBLIC_URL` in the env file first, then run
`create`, `dns` and recreate the box, so sign-in and `allowedDevOrigins` use
that host. The
public dev server is open to anyone who has the URL, which is acceptable
because it holds only local throwaway data (any email and password signs up); the production-facing view of the friend's
frontend comes through Lianki's custom-frontend `?live` feature instead.

### dsh behind Cloudflare Access

Owner confirmed (2026-11-05, typed) `dsh-kishouzet.lianki.com` (allow only the
friend's account email) and `dsh-snomiao.lianki.com` (allow only the owner's
address, an active owner in `site_role`). **Not created yet:** no credential on the Mac can make Access
applications. Wrangler's OAuth has no Access scope, and cloudflared's
`cert.pem` covers only tunnels and DNS. It needs an API token with
**Account · Access: Apps and Policies · Edit**, made by the owner. The order
below matters; dsh must never be routed before its Access app is live:

1. Make the Access application (self-hosted, `dsh-<name>.lianki.com`, one
   Allow policy on the single email). Note its **AUD tag** and the Zero Trust
   team name.
2. In the box's env file set `DEVBOX_DSH_PUBLIC_HOST=dsh-<name>.lianki.com`,
   `DEVBOX_DSH_ACCESS_AUD=<aud>` and `CF_ACCESS_TEAM=<team>`, then recreate the
   box: `start.sh` binds dsh to the container's address with `--public-url`
   and `--trusted-host`.
3. `devbox/host-tunnel.sh create` adds the dsh rule with `originRequest.access`
   (`required: true`, team, AUD), so the **connector itself** rejects any
   request without a valid Access token for that app. Restart the oxmgr
   connector.
4. `OWNER_APPROVED_DNS=1 devbox/host-tunnel.sh dns-dsh`. It refuses unless the
   AUD and the Access-gated rule are in place.
5. Check: `curl -sI https://dsh-<name>.lianki.com/` gives a 302 to
   `<team>.cloudflareaccess.com`, never dsh.
