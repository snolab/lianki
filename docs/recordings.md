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

`db/migrations/0075_recording.sql`; primary key `(user_id, id)`. The audio
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
| `GET [?before=<day>&limit=<n>]`        | session or token             | `{days: [{day, clips, ms, bytes}], more}`, newest first, 30 a call (≤ 100) |
| `GET ?day=YYYY-MM-DD`                  | session or token             | `{day, clips: [{id, at, durationMs, bytes, mode, source, device, speaker, text}]}`, transcripts decrypted, no audio |
| `GET ?clip=<id>`                       | session or token             | the WAV (`audio/wav`)                                                  |
| `GET ?day=D&archive=zip[&tz=<min>]`    | session or token             | the day as a zip (below)                                               |
| `POST {id, at, day, text, source, mode, device, speaker?, wav}` | session only | `{ok, id[, dup]}`                                                  |
| `DELETE ?clip=<id>` / `DELETE ?day=D`  | session only                 | `{ok, deleted}` — rows and objects                                     |

The token is an API token with the **`recordings:read`** permission
(`lib/api-tokens.ts`): an owner permission (`OWNER_SCOPES`), offered and
accepted only for an account holding `dev`, at most 30 days. It reads; it can
never record, change or delete. The route still checks `dev` and the flag at
every use.

**POST validation** (`parseRecordingPost`): exactly those keys; `id`
16–32 base64url characters; `at` an integer within 2 days behind and 5 min
ahead of the server's clock; `day` a real calendar date within a day and a
half of `at` (the device's own date, any zone); `text` ≤ 4,000 characters, no
control characters but tab and newlines (empty allowed); `source`, `mode`,
`speaker` from their lists; `device` ≤ 40 of `[A-Za-z0-9._-]`; `wav`
standard base64 of a RIFF/WAVE, PCM 16-bit mono **16 kHz**, 0.1–40 s,
≤ 1,300,000 bytes (`RECORDING_LIMITS`, checked by the same `parseWav` as the
voice-clone reference). A body over `MAX_POST_BODY` is refused (413) before it
is parsed. At most `MAX_CLIPS_PER_DAY` (5,000) clips a day per account (429
`day-full`). The caps are named constants, not config keys: they bound what
the Worker decrypts and holds in memory.

### Download a day (the zip)

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

## The page: /my/recordings

`app/(app)/my/recordings/` — days newest first in the one `VirtualList`
(continuous scroll, more as the reader nears the end; no pages). A day opens to
its clips: time, duration, a "Not for the chat" tag on passive ones, "Another
voice" when the Mac said so, the transcript, and a player (`preload="none"`:
nothing plays until tapped). Download day (the zip), Delete day, Delete clip —
each asks "Delete for good?" inline first. Strings: `my-recordings.content.ts`,
16 locales, a context line each. The /my card shows only where the page exists
(flag and `dev`).

## Retention

Config [`recordings.retentionDays`](https://lianki.com/dev/config) (default
**90**, 1–3650). The Worker's existing daily Cron Trigger (`worker.ts`
`scheduled`, beside the ledger's anchor and /vibe's sweep) deletes every clip
recorded more than that many days ago, any account, the R2 object first, then
the row (`lib/recordings-sweep.ts`; at most 25 × 200 a run, the next run takes
the rest). Nothing new polls. Shortening it deletes the excess at the next
daily run, for good.

## Deleting

He deletes a clip or a whole day on /my/recordings (`DELETE`), rows and
objects at once. Turning the flag off does **not** delete anything: new clips
stop, the routes 404, stored clips stay sealed and unread — and are still
swept when they pass the retention.

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

## Phase 2 (not done)

- A queue that survives a reload (IndexedDB), so clips recorded just before a
  refresh are not lost.
- Re-transcriptions from the Mac written back to the account (a
  `recordings:write`-style permission, text only).
- Search across days; per-speaker filters; a day's audio as one long file.
- A per-account retention choice (today one global value).
