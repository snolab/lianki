# Mic recordings in your account

The owner decided on 2026-11-14 (tap card, ~03:35 JST, "批准：开始做"): while
his microphone is on in Lianki, keep the **audio and its transcript in his
account**, so he can review a day later and download it — including other
people's voices in a meeting (he accepted that). He also downloads them to his
Mac for offline processing (re-transcription). Two follow-ups the same night:
transcription and any further processing run **locally on his Mac**, never in
the cloud (03:37 JST); and recordings include **passive mode** — what the mic
heard but did not send to the chat (03:38 JST).

Gate: flag [`voice.recordings`](https://lianki.com/dev/flags#voice.recordings)
(**default on**, `audience: "owner"`; the flag is his kill switch) **and** the
`dev` permission on the account (`lib/permissions.ts`). Either missing:
`/api/my/recordings` and `/my/recordings` answer 404, the /my card is not
shown, and the mic sends nothing. Off D1: 503.

## What is kept

Every **finished utterance while the mic is on**, active or passive, sent to
the chat or not (`packages/debug-chat/src/mic.ts`, `record`):

| utterance                                                   | kept?                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| active, transcribed (the chat's line)                       | yes, with that text                                    |
| active, the Mac's voiceprint filter stopped it (another voice) | yes, **without text** (`source: "none"`)            |
| active, STT failed                                          | yes: the Mac's text if it came, else without text      |
| passive, no "Linky" (not for the chat)                      | yes, with the Mac's text for it (see below)            |
| passive, someone else's "Linky"                             | yes, with the Mac's text, `speaker: "other"`           |
| the agent's own voice (echo), a cue, a misfire              | no                                                     |
| a blip the silence guard or the cleaner dropped, a stock hallucination | no                                          |
| an enrolment sentence (voiceprint)                          | no                                                     |
| a typed line                                                | no — nothing is recorded for text                      |
| anything while the mic is off                               | no — the mic hears nothing then                        |

A clip without any text is kept only from `RECORD_BARE_MIN_MS` (500 ms) on.

**Other people's voices are kept.** In a meeting the mic hears everyone; their
words are recorded with his. Only his account can read them (below).

Each clip: the audio exactly as encoded for STT (16 kHz mono 16-bit PCM WAV,
≤ 40 s: the mic cuts at 30 s, plus its pre-pad), the transcript, when it
ended, its duration, active or passive, the transcript's source (`local` = his
Mac, `cloud` = the chat's fallback route when the Mac was not reachable,
`none`), the device label (`iphone`, `mac`…), and the Mac's speaker check
(`me` / `other` / `unknown`) when there was one.

### Transcription is local only

The server **never transcribes a recording** — no Workers AI, no cloud STT.
It stores what the client sends: the text the mic already had for the chat.
For a **passive** utterance (which never went to the chat), the page asks his
own local STT (the Mac's speech server over the tailnet, the tunnel, or his
own WebRTC route — never a public speech server of someone else's) for its
text, and only once the account is known to have recordings on; when the Mac
is not reachable the clip is kept without text. Re-transcription happens on
the Mac (`recordings-pull.ts --stt`, below).

This changes one promise of passive mode ([wake-word.md](wake-word.md)):
before, an utterance without "Linky" never left the phone; with recordings on,
it goes to his own Mac for its text and, sealed, to his own account.

## The client: a background queue

`packages/debug-chat/src/recorder.ts`, made once per page
(`globalThis.__lkRecorder`) and fed by the mic session (`MicButton.tsx`,
`record`):

- Before anything is sent it asks `GET /api/my/recordings?status=1` once.
  404 (flag off, no `dev`, signed out): nothing is sent, the queue empties,
  and new clips are not even queued; the answer is kept for an hour (an "on"
  for ten minutes), then asked again at the next utterance — never by a timer.
- Clips are POSTed one at a time, never blocking the chat. 5xx / network /
  408 / 429: retried after 2 s, 10 s, 30 s, 60 s; dropped after 5 tries. Any
  other 4xx: dropped at once (sending it again changes nothing). 401/403/404
  on a POST: off, the queue empties.
- Bounded (`RECORDER_LIMITS`): at most 40 clips and 8 MB waiting; past either
  the oldest goes. Memory only: a reload drops what had not gone yet.
- Each clip has a random id (16 bytes, base64url): a retried upload is the
  same clip (the server answers `dup: true`).

## Storage and encryption

| part                                         | where                                                       | form                     |
| -------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| the WAV                                      | R2 `lianki-blobs`, key `recordings/<user id>/<day>/<clip id>` | AES-256-GCM sealed bytes |
| its transcript                               | D1 `recording.text_sealed`                                  | AES-256-GCM sealed text  |
| day, time, duration, size, mode, source, device, speaker | D1 `recording`                                  | clear                    |

`db/migrations/0075_recording.sql`; primary key `(user_id, id)`; the feed
reads index `recording_user_at` (`0080`).

**The day is internal, and UTC** (owner, 2026-11-15: nothing defaults to JST;
a fixed zone is UTC, what is shown is in the device's zone). A new row's `day`
— in the R2 key and the D1 column — is the **UTC date of `at`**: the recorder
sends it so (`utcDay`, `recorder.ts`) and the server files the row under it
whatever the body says. Rows stored before 2026-11-15 keep the device-local
day they were sent with; every read works by id or by time, so both kinds
read the same. No page ever groups by this day. The audio
goes to R2 first, then the row points at it; a failed row write deletes the
object, so a row never points at nothing.

The key is HKDF-SHA256 from the existing Worker secret `AUTH_SECRET`, salt
`lianki/recordings`, info `lianki/recordings/at-rest/v1`
(`recordingsKey`, `lib/recordings.ts`): no new secret, and neither the
voice-clone reference's key nor the voiceprint's nor the Google tokens'. The
AAD is `recording`, the **user id**, the **kind** (`audio` / `text`) and the
**clip id**: a sealed half copied to another account, swapped for the other
kind, or paired with another clip does not open. Sealed audio is `LKR1` +
12-byte IV + ciphertext and tag; the transcript is sealed as a JSON string
with the shared `seal()` format. A D1 export or an R2 listing alone reads
nothing. Rotating `AUTH_SECRET` leaves old clips unreadable (the page shows
"cannot be opened"; the archive leaves their audio out).

## Who can read it: the API

`app/api/my/recordings/route.ts`, logic in `lib/recordings.ts`. **Own rows
only**: every statement carries the caller's user id; nothing in a request
names an account.

| call                                   | auth                         | answer                                                                 |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `GET ?status=1`                        | session or token             | `{on: true, retentionDays}` (404 when off)                             |
| `GET [?before=<at>&limit=<n>]`         | session or token             | `{clips: [{id, day, at, durationMs, bytes, mode, source, device, speaker, text}], more}`: the feed, newest first, **paged by time, never by day**; 50 a call (≤ 200), plus any further clip with the last one's `at`, so `before=<that at>` loses none |
| `GET ?day=YYYY-MM-DD`                  | session or token             | `{day, clips: [{id, at, durationMs, bytes, mode, source, device, speaker, text}]}`, transcripts decrypted, no audio |
| `GET ?clip=<id>`                       | session or token             | the WAV (`audio/wav`)                                                  |
| `GET ?day=D&archive=zip[&tz=<min>]`    | session or token             | the day as a zip (below)                                               |
| `POST {id, at, day?, text, source, mode, device, speaker?, wav}` | session only | `{ok, id[, dup]}`                                                 |
| `DELETE ?clip=<id>` / `DELETE ?day=D`  | session only                 | `{ok, deleted}` — rows and objects                                     |

The token is an API token with the **`recordings:read`** permission
(`lib/api-tokens.ts`): an owner permission (`OWNER_SCOPES`), offered and
accepted only for an account holding `dev`, at most 30 days. It reads; it can
never record, change or delete. The route still checks `dev` and the flag at
every use.

**POST validation** (`parseRecordingPost`): exactly those keys; `id`
16–32 base64url characters; `at` an integer within 2 days behind and 5 min
ahead of the server's clock; `day` optional — the UTC date of `at` from a
current recorder, the device's own date from an older one: any real calendar
date within a day and a half of `at` is accepted, and the row is filed under
the UTC date either way; `text` ≤ 4,000 characters, no
control characters but tab and newlines (empty allowed); `source`, `mode`,
`speaker` from their lists; `device` ≤ 40 of `[A-Za-z0-9._-]`; `wav`
standard base64 of a RIFF/WAVE, PCM 16-bit mono **16 kHz**, 0.1–40 s,
≤ 1,300,000 bytes (`RECORDING_LIMITS`, checked by the same `parseWav` as the
voice-clone reference). A body over `MAX_POST_BODY` is refused (413) before it
is parsed. At most `MAX_CLIPS_PER_DAY` (5,000) clips a day per account (429
`day-full`). The caps are named constants, not config keys: they bound what
the Worker decrypts and holds in memory.

### Download a day (the zip)

The API keeps it (`GET ?day=D&archive=zip`, the internal UTC day), but the page
no longer offers it (owner, 2026-11-15: no Download day / Delete day buttons).
An export of any time range, in the viewer's own dates, is for later
(Phase 2); until then the pull script below fetches a day.

A day can be a few hundred MB of audio, more than a Worker should hold. The
archive is a **stored (uncompressed) zip written as a stream**
(`lib/zip-stream.ts`): `transcript.txt` and `transcript.json` first (the
transcripts are small, read up front), then each clip's WAV — fetched from R2,
opened, written — **one at a time, as the reader pulls**. Memory holds one
clip, never the day. Stored, not deflated: WAV hardly compresses, and the CPU
is better spent decrypting. Each entry carries its CRC-32 in its local header
(the clip is whole in memory before it is written, so no data descriptors).
Classic zip, not zip64: past 65,535 entries or ~4 GB the request is refused
(413) before anything streams — use the pull script, which fetches clip by
clip. File names are `HHMMSS-<clip id>.wav` in the viewer's zone (`tz`, the
browser's `getTimezoneOffset()`); `transcript.txt` is one line per clip,
`HH:MM:SS [speaker] text`.

### On the preview (dev bridge)

His whole-page preview server (docs/dev-whole-page.md) signs with its own
`AUTH_SECRET`, so its copy of this route would get text `null` and audio 410
from production's sealed rows. Owner decision 2026-11-14 21:48 JST ("走 A"):
the key is **not** copied. Instead, on the preview (`LIANKI_DEV_WHOLE_PAGE=1`
and `LIANKI_DEV_BRIDGE_SECRET`, which `serve` sets from `.dev-whole-page.json`
`bridgeSecret`), the route first checks his preview session, `dev` and the
flag as usual, then forwards the request — same method, query and body, no
cookie, no token — to `https://lianki.com/api/my/recordings` with
`x-lianki-dev-bridge` (`lib/recordings-bridge.ts`), and streams back the
status, content type, content disposition and body. lianki.com accepts that
header as the owner on this route, every method (`lib/dev-bridge-user.ts`;
docs/secrets-and-auth.md, "Dev bridge"); a wrong value is 401. Clips recorded
on the preview are therefore sealed by lianki.com too. Without the secret the
route serves itself as before. lianki.com unreachable: 502
`bridge-unreachable`.

## The page: /my/recordings

`app/(app)/my/recordings/` — **one continuous journal** (owner, 2026-11-15 03:2x
JST: "录音列表不需要在数据层按日期切分，而是一个连续的分页…按前端的当地时间来分组";
"显示成长长的段落形状的…像日记一样"):

- **The feed is not cut by day.** The page reads `GET ?before=<at>&limit=100`,
  newest first, in the one `VirtualList` (continuous scroll, more as the reader
  nears the end; no page controls — "no pagination").
- **Dates come from the device.** The client groups the clips into dates in
  the device's own time zone (`Intl…resolvedOptions().timeZone`; an unknown
  zone falls back to UTC, never JST): a date heading (`dateStyle: "full"` in the
  page's locale, with the date's clip count and length), then that date's clips
  in recording order. Dates run newest first. While more may come, the
  **oldest date loaded is held back** until it is whole (the next page reaches
  an earlier date, or there is no more), so a date's first lines never appear
  above the reader later; a page that only adds to the held date fetches the
  next at once (`keepLoading`).
- **Paragraphs, not a log.** Each clip is one paragraph of flowing text (a row
  of the same `VirtualList`, so long dates stay windowed), a "Not for the chat"
  tag on passive ones, and a faint mark above it — "My voice" / "Another voice"
  from the Mac's check, and the device label — only where that changes. A
  **time** shows only at a date's first paragraph and where the clip began more
  than [`recordings.timeMarkGapMin`](https://lianki.com/dev/config) minutes
  (default **10**) after the one before ended — not at every clip. Times are in
  the device's zone and the page's locale.
- **No per-day buttons** (owner, same night: "不需要显示下载这一天和删除这一天的这两个
  按钮"): a clip is deleted from its ⋯ menu; downloading a day is the pull
  script's (above, "Download a day").

The model is pure: `lib/recordings-view.ts` (`journal`, `zoneDay`,
`mergeClips`, `cursor`, `keepLoading`; `unit/recordings-journal.test.ts`) and
`lib/recordings-article.ts` (`paragraphs`, time marks; 
`unit/recordings-article.test.ts`).

**One shared player** (a single hidden `<audio preload="none">`; nothing plays
until tapped):

- A tap anywhere in a paragraph plays that clip from its beginning; a tap on
  the playing one pauses, on the paused current one resumes (`playTarget`).
  Selecting words is not a tap. The current paragraph is highlighted
  (seal-red tint).
- The date plays on: when a clip ends the next one starts and is scrolled into
  view (`VirtualList` handle `scrollToKey`), until the date's last clip.
- **One continuous progress bar for the date** (owner, 2026-11-14 22:5x JST): a
  glass bar floating at the bottom, for the date in the player — it appears at
  the first tap on a paragraph and stays, paused, after. The
  day's clips lie end to end on it — durations summed, the silence between
  them not drawn — with a faint tick at each boundary. It shows the position
  while playing; tapping or dragging it seeks across the whole day
  (`locate`): within the current clip at once, to another clip once the drag
  rests (120 ms), switching the audio source. A play/pause button sits beside it.
- Each paragraph's **⋯ menu** (a glass panel that follows its button on a
  scroll): Play from here (always from the clip's beginning), Speed, Download
  this recording (the clip's WAV, `GET ?clip=`), Copy text, Delete (the same
  inline "Delete for good?" as before).
- **Speed** is a device preference, localStorage `lk:pref:recordings-speed`
  (never synced); the choices are config
  [`recordings.speeds`](https://lianki.com/dev/config) (default
  `0.75,1,1.25,1.5,2`; 1 is always offered; an unknown stored value plays at 1).

The page uses the feed (`GET ?before=`), `GET ?clip=` and `DELETE ?clip=`;
`GET ?day=` and `DELETE ?day=` stay in the API (the pull script, the bridge)
but the page no longer calls them. Strings:
`my-recordings.content.ts`, 16 locales, a context line each. The /my card
shows only where the page exists (flag and `dev`). Browser check, silent and
with fixture APIs: `bun scripts/qa/qa-recordings-view.mjs` (`QA_SHOT_DIR=…`
saves light and dark phone shots).

## Replay from the chat

Owner, 2026-11-21 01:1x JST: his own spoken line's details in the Li chat
(right-click / long press, `MessageDetails.tsx`) offer **Play original
audio** — the line's recording, as it was recorded. Flag
[`chat.line-replay`](https://lianki.com/dev/flags#chat.line-replay) (**default
on**, `audience: "owner"`), only with `voice.recordings` on and the `dev`
grant — the same gate as this page; the route checks it again at every call.

- **No stored link.** A clip has no chat line id. The mic stamps a recorded
  utterance's `at` between two times it puts on the line's `timing`:
  `t_speechEnd` ≤ `at` ≤ `t_uploadStart`, the same device's clock, a few ms
  apart. The details ask the feed (`GET ?before=<t_uploadStart+1>&limit=5`,
  own rows only) and take the clip whose `at` is in that window; a merged line
  looks up each part and numbers its chips. No timing (a typed line, PTT, an
  older page), no clip in the window, or the route says 404: **nothing is
  shown**. `packages/debug-chat/src/line-replay.ts`, `LineReplay.tsx`.
- **Played by Li's player** (`li-player.ts`, the ▶ chip of `PlayChip.tsx`):
  `GET ?clip=<id>` on the page's one line-audio element, with his own session
  cookie — never over his open mic (the chip says so), paused while Li
  speaks. Only on lines `from: "owner"`, `source: "stt"`.
- String `lineReplay` in `chat-ui-locales.ts` (16 locales, a context line).
  Tests: `unit/line-replay.test.ts` (fakes only, no sound).

## Retention

**Kept forever** (owner, 2026-11-25 22:54 JST): config
[`recordings.retentionDays`](https://lianki.com/dev/config) defaults to **0**
(0–3650) = never deleted automatically; a clip goes only when he deletes it
himself. /my/recordings says so ("kept permanently … only when you delete it
yourself"). Until then the default was 90 days; no value was ever stored in
D1, so nothing was swept before the change took effect.

Setting a number of days turns the sweep back on: the Worker's existing daily
Cron Trigger (`worker.ts` `scheduled`, beside the ledger's anchor and /vibe's
sweep) then deletes every clip recorded more than that many days ago, any
account, the R2 object first, then the row (`lib/recordings-sweep.ts`; at most
25 × 200 a run, the next run takes the rest). At 0 it returns before any
query. Nothing new polls. Setting a number deletes the excess at the next
daily run, for good.

## Deleting

He deletes a clip on /my/recordings (`DELETE ?clip=`), row and object at
once. `DELETE ?day=` (an internal day) stays in the API; the page has no
button for it (2026-11-15). Turning the flag off does **not** delete anything: new clips
stop, the routes 404, stored clips stay sealed and unread (and are swept
only if a retention is set).

## On the Mac: offline processing

```
bun scripts/dev/recordings-pull.ts --day 2026-11-14            # download the day
bun scripts/dev/recordings-pull.ts --day 2026-11-14 --stt      # and re-transcribe on this Mac
bun scripts/dev/recordings-pull.ts --day 2026-11-14 --stt ws://127.0.0.1:5193 --out ~/elsewhere
```

- Token: an API token with **Read your mic recordings** (`recordings:read`),
  made at lianki.com/my/preferences → API tokens; passed as `--token`,
  `LIANKI_RECORDINGS_TOKEN`, or saved in `~/.config/lianki/recordings.token`.
- Writes `~/lianki-recordings/<day>/`: `transcript.json`, `transcript.txt`,
  one `HHMMSS-<id>.wav` per clip. A clip already there is not fetched again,
  so it can be re-run.
- `--stt [url]` sends each WAV to the Mac's own speech server
  (`scripts/local-stt/server.py`, default `ws://127.0.0.1:5193`, its socket
  protocol: `begin`, `0x01` + PCM frames, `end` → `final`;
  [local-stt.md](local-stt.md), "Protocol") and writes `<clip>.local.txt`
  beside each WAV, plus `transcript.local.txt` / `.json` for the day.
- **Local only.** The only network calls are reading from lianki.com and the
  local STT socket. Nothing is uploaded anywhere.

## CLI and MCP (`recordings:read`)

The standard `lianki` CLI and local stdio MCP server (`lianki mcp`) expose
read-only access to the token account's own mic recordings when the token holds
`recordings:read`:

```bash
lianki recordings list --limit 10 --json
lianki recordings list --before 1700000000000 --limit 5 --json
lianki recordings list --day 2026-11-27 --json
lianki recordings get <id> --out /tmp/recordings --json   # downloads <id>.wav locally (flag wx; never overwrites)
```

**Cloud disclosure boundary (CLI vs local stdio `lianki mcp` vs remote `/mcp`):**
both remote MCP clients at `https://lianki.com/mcp` and most local stdio MCP
clients (Claude Code, Codex, Gemini CLI) are backed by cloud models, so
returning raw audio bytes over MCP sends recordings to the cloud. Therefore:

- **Plain local CLI** (`lianki recordings list`, `lianki recordings get <id> --out <dir>`):
  - Always allowed with `recordings:read`: downloads the clip's WAV directly to
    a local file without sending audio to any model.
- **Local stdio `lianki mcp`** (`recordings:read`):
  - `lianki_recordings_list` (`{ limit?, before?, day? }`): returns full clip
    metadata and transcripts as untrusted data. To match a spoken chat line's
    clip, pass `before = timing.t_uploadStart + 1` and `limit = 5`, then pick
    the clip whose `at` falls in `[t_speechEnd, t_uploadStart]`.
  - `lianki_recordings_audio` (`{ id }`): **off by default** on local stdio MCP.
    Enable only by explicit opt-in via `lianki mcp --allow-audio` or
    `LIANKI_MCP_ALLOW_AUDIO=1` — **sends recordings to whatever model reads this
    MCP**. Without that opt-in, `lianki_recordings_audio` is omitted from
    `tools/list`, no binary audio fetcher is wired into stdio MCP, and any
    direct call is refused (`audio_opt_in_required`) without hitting
    `/api/my/recordings`. When opted in, it fetches the clip's WAV audio
    (streamed with a hard `1,300,000`-byte cap) and returns an untrusted
    metadata text block plus an MCP `audio` content block (`audio/wav`, base64).
- **Remote `https://lianki.com/mcp`** (`recordings:read`):
  - `lianki_recordings_list` returns non-content metadata only (`id`, `at`,
    `durationMs` — never transcripts, speaker/device details, or audio).
  - `lianki_recordings_audio` is always omitted from `tools/list`, and any
    direct call is refused with `"audio is only available locally"` without
    fetching audio bytes from `/api/my/recordings` (the remote MCP Worker has no
    binary audio fetcher wired in).

Missing `recordings:read` scope returns a public approval link without hitting
`/api/my/recordings`. Neither CLI nor MCP exposes write or delete operations
for recordings.

## Phase 2 (not done)

- A queue that survives a reload (IndexedDB), so clips recorded just before a
  refresh are not lost.
- Re-transcriptions from the Mac written back to the account (a
  `recordings:write`-style permission, text only).
- Search across days; per-speaker filters; a day's audio as one long file.
- Export any time range from the page (zip), in the viewer's own dates — the
  replacement for the removed Download day button.
- A per-account retention choice (today one global value).
