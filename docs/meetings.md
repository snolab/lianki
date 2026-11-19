# Meetings: record screen and sound into your account (design)

**Status: M0–M2 built (branch `feat/meetings-m0-m2`), dark behind `meetings.record`; M3–M5 to come.** Owner's request, 2026-11-18 13:31 JST:
"lianki should have a meeting record mode which allows screenshare and records
both mic and screen audio and upload to my account as /my/meetings".

Short version: on a desktop browser, one tap shares a tab or screen and
records it, with the microphone and the shared tab's sound mixed in. The
recording goes up to the account in 30-second pieces, sealed, and is played
back at `/my/meetings/<id>`. A transcript is optional, chosen per meeting, and
made on Lianki's speech server (the owner's Mac) unless he picks the cloud for
that meeting.

## What it is, and what it is not

| | /vibe ([vibe.md](vibe.md)) | /my/recordings ([recordings.md](recordings.md)) | **/my/meetings (this)** |
| --- | --- | --- | --- |
| What is captured | mic → text | mic utterances (VAD clips ≤ 40 s) | **screen video + mic + tab/system audio, continuous** |
| Audio stored? | no, stays on the Mac | yes, 16 kHz WAV clips, sealed in R2 | **yes, plus video**, sealed in R2 |
| Transcript | live, Mac only | the text the mic already had | **optional per meeting, afterwards**; local by default |
| Devices | phone or desktop | any | **desktop Chrome / Edge only** (below) |
| Starts | tap on Start | the chat mic being on | **tap on Start, then the browser's picker** |

A correction to the brief: this is **not** the first Lianki feature that
uploads audio. /my/recordings has kept the owner's mic clips in R2 since
2026-11-14 (`lib/recordings.ts`, flag `voice.recordings`). Meetings is the
first that uploads **video** (whatever is on the shared screen) and **long
continuous audio** of other people. So it is treated as a new recording
change: its own flag, its own key, its own table, nothing shared with the
recordings feed.

Not in v1: sharing a meeting with anyone, live viewing from another device,
recording on a phone, a bot that joins Zoom/Meet, separating the other
speakers from each other, summaries by a model.

## The gate

| piece | value |
| --- | --- |
| Flag | **`meetings.record`**, `default: false`, `audience: "owner"` (`lib/flags.ts`). Positive name: on means recording is possible. Recording is one of the exceptions to "new flags ship on" |
| Permission | the `dev` grant (`isDev`, `lib/permissions.ts`), as /my/recordings. Never an email |
| Off | `/my/meetings*` and `/api/my/meetings*` answer 404, the /my card is hidden, no new meeting starts. A meeting **already recording stops at its next chunk** (the PUT answers 404). Stored meetings stay sealed and unread, and retention still applies |
| Off D1 | 503 |

Opening up to other users later is a second, separate step (owner's call).
`/my` pages are "never owner-only" ([url-principles.md](url-principles.md),
"/my"); the flag's audience plus the grant is the same exception
/my/recordings already uses.

## Starting, and what everyone sees

**Start only on a real tap.** `/my/meetings/new` has one Start button. It
ignores untrusted clicks (`event.isTrusted`, as /vibe's Start does,
`app/(app)/vibe/VibeClient.tsx`). Order on tap:

1. `POST /api/my/meetings {tap: true}` → the meeting row (`status: "recording"`).
   A refusal opens nothing.
2. `getDisplayMedia()` — the browser's own picker. The browser itself refuses
   this without a user gesture (transient activation) and never remembers the
   permission (MDN, below). So no URL, voice command, eval or reload can start
   a recording.
3. `getUserMedia({audio})` for the mic (one switch on the start page, on by default).
4. The recorders start.

Nothing starts on load. A reload does not resume recording (see "Tab close").

**Recording indicator** (ours, on top of the browser's own sharing bar and mic dot):

- A glass bar floating at the bottom of **every Lianki page** in that tab
  ([design-principles.md](design-principles.md), glass overlays): a red dot,
  "Recording", elapsed time, size, pieces waiting to upload, Pause and Stop.
  Seal red is the brand colour, so "recording" also carries the dot and the word,
  never colour alone.
- The tab title gets a `● ` prefix while recording.
- The recorder is a page singleton (`globalThis.__lkMeeting`, like
  `__lkRecorder` in `packages/debug-chat/src/recorder.ts`) and the bar is
  mounted from the app layout, so moving between Lianki pages keeps
  recording. A full reload ends it.
- The meeting does **not** pause when the tab is hidden (unlike /vibe): the
  user is usually in the meeting's own tab.

**A line for the other people in the meeting.** Lianki cannot tell people in a
Zoom or Meet call anything itself. So:

- The start page carries one line to the user, in the style of /vibe's
  `yourCare`: you are recording other people; tell them first, and check what
  the law where you all are asks of you.
- A **Copy notice** button copies a short sentence to paste into the meeting
  chat ("I'm recording this meeting, screen and sound, for my own notes."),
  in the page's language.
- No checkbox and no dialog, as with /vibe (open question 3).

## Capture in the browser

### What browsers can do (checked 2026-11-18)

Verified against MDN's browser-compat-data (`api/MediaDevices.json`,
`api/MediaRecorder.json`, fetched 2026-11-18) and the MDN `getDisplayMedia()`
page:

| browser | screen share | its sound | MediaRecorder |
| --- | --- | --- | --- |
| Chrome / Edge desktop | yes (72+ / 79+) | **yes, 74+**: a tab's sound everywhere; **the whole system's sound only on Windows and ChromeOS** when sharing an entire screen. **On macOS and Linux, only a tab's sound** | 47+ |
| Firefox desktop | yes (66+) | **no** | 25+ |
| Safari macOS | yes (13+) | **no** | 14.1+ |
| Safari iOS | listed from 27 | **no** | 14+ |
| Chrome Android, Firefox Android | **no** | no | yes |

Chrome options also verified there: `systemAudio` (105+, a hint only),
`selfBrowserSurface` (112+, default `exclude`), `surfaceSwitching` (107+),
`windowAudio` (141+, partial). MDN: transient activation is required, and "the
go-ahead permission … cannot be persisted".

From secondary sources (web search, not the specs): Chrome records MP4 from
126 where the OS has an encoder; Safari records WebM from 18.4. Feature
detection with `MediaRecorder.isTypeSupported()` decides either way.

**What this means for the owner on his Mac:** a meeting in a **browser tab**
(Meet, Zoom web, Teams web) records with its sound. A meeting in the **native
Zoom or Teams app** records the screen but **not the other people's voices**,
because Chrome on macOS cannot capture window or system sound. The mic still
picks them up if he is not on headphones. The start page says this in one
line when the platform is macOS or Linux (open question 1).

**v1 supports Chrome and Edge desktop.** Elsewhere the Start button is
disabled with a one-line reason. Firefox and Safari could record the screen
and mic without the other side's sound; not worth it in v1. **Phones:
unsupported for recording.** The list and the player work on a phone, since the
owner reads on his phone.

### The streams

```
getDisplayMedia ─ video ───────────────────────────────┐
                └ tab/system audio ─┬─ Web Audio mix ──┼─▶ recorder "av"   (one file, for playback)
getUserMedia ──── mic ──────────────┤                  │
                                    ├────────────────────▶ recorder "me"   (mic only, for the transcript)
                 tab/system audio ──┴────────────────────▶ recorder "others" (their sound only)
```

- **Mix:** one `AudioContext` (resumed inside the tap), a
  `MediaStreamAudioSourceNode` per input, both into one
  `MediaStreamAudioDestinationNode`; its track plus the display's video track
  form the `av` stream. Chrome's MediaRecorder records only one audio track,
  so mixing is required.
- **Two small audio-only tracks, `me` and `others`.** They give speaker labels
  for nothing ("Me" / "Others", by which track a line came from) and audio the
  transcriber can decode piece by piece. About 32 kbps each, ~30 MB an hour together.
- Mic constraints: `echoCancellation`, `noiseSuppression` on (the mic hears
  the speakers otherwise). The transcript drops a `me` line that repeats a
  `others` line within 2 s.
- `getDisplayMedia` options: `video: {frameRate}` from config, `audio: true`,
  `selfBrowserSurface: "exclude"` (no hall of mirrors), `surfaceSwitching:
  "include"`, `systemAudio: "include"`.
- No display sound in the chosen surface (a window on macOS, say): the meeting
  records anyway and the bar says "No sound from the shared screen".

### Formats

| recorder | first choice (if `isTypeSupported`) | fallback |
| --- | --- | --- |
| `av` | `video/mp4;codecs=avc1,mp4a.40.2` (plays on an iPhone) | `video/webm;codecs=vp9,opus`, then `vp8,opus` |
| `me`, `others` | `audio/webm;codecs=opus` | `audio/mp4;codecs=mp4a.40.2` |

The list is a config key (`meetings.mimeTypes`), so it can change without a
deploy. The chosen type is stored on the meeting.

### Pieces ("chunks")

- `av` runs **one continuous MediaRecorder** with `timeslice =
  meetings.chunkSec` (default **30 s**). Its pieces are consecutive bytes of
  one file. Nothing is lost between them.
- `me` and `others` are **restarted at each `av` piece** (stop → start, driven
  by `av`'s `dataavailable` event, not a timer), so each piece is a complete,
  decodable file. A gap of a few ms at each restart is fine for a transcript.
  Event-driven, nothing polls.
- **Before upload, every piece goes to IndexedDB** (`lk-meetings` store, keyed
  `<meeting>/<track>/<seq>`). It leaves IndexedDB only after the server
  confirms it. So **a crash, reload or lost network costs at most the piece
  being recorded** (≤ 30 s).
- Upload is one piece at a time, in order, beside the recording. On 5xx,
  network, 408 or 429 it retries after 2, 10, 30 and 60 s, then waits for the
  `online` event. 404/401/403 stops the meeting. The bar shows what is waiting.
- `av`'s first piece holds the file header. The client records, per piece,
  the byte offset and media time of the **first fragment start** in it (a WebM
  `Cluster` or an MP4 `moof`) so the player can seek (below).

### Pause, stop, tab close

| event | what happens |
| --- | --- |
| Pause / Resume (bar) | `recorder.pause()` / `resume()` on all three; the display stays shared |
| Stop (bar), or the browser's "Stop sharing" (video track `ended`) | final `requestData()`, recorders stop, tracks stopped, `POST …/end` once the last piece is up |
| Mic track ends (unplugged, a call) | keeps recording the screen and its sound; the bar says "Mic lost"; Resume mic is a tap |
| Network gone | recording goes on into IndexedDB; upload resumes on `online` |
| Tab closing | `beforeunload` asks "Recording in progress — leave?". If the user leaves, the piece in progress is lost; pieces already in IndexedDB are not |
| Next visit to any /my/meetings page | pieces left in IndexedDB are uploaded (nothing new is recorded, so no tap is needed); the meeting becomes `interrupted` with its real length |
| A meeting left `recording` with no piece for `meetings.staleMin` (default 30) | the daily sweep marks it `interrupted` |
| Length reaches `meetings.maxMinutes` | stops as for Stop, saying why |

While a meeting records, the chat mic is blocked as /vibe blocks it
(`micTaps().block()`, `packages/debug-chat/src/mic-taps.ts`, and the
`BroadcastChannel` to other tabs). Otherwise the room's voices would also land
in /my/recordings.

## Storage

### R2 (bucket `lianki-blobs`, binding `BLOBS`, `wrangler.jsonc`)

```
meetings/<user id>/<meeting id>/av/000000
meetings/<user id>/<meeting id>/av/000001 …
meetings/<user id>/<meeting id>/me/000000 …
meetings/<user id>/<meeting id>/others/000000 …
```

- `<meeting id>`: random, 16 bytes base64url. Never a count.
- **Sealed** as recordings are (AES-256-GCM, `lib/connections/crypto.ts`
  style). The key is HKDF-SHA256 from `AUTH_SECRET` with its own salt
  `lianki/meetings` and info `lianki/meetings/at-rest/v1`, so no new secret
  and not the recordings key. AAD = `meeting`, user id, meeting id, track,
  seq: a piece copied elsewhere or reordered does not open. Format `LKM1` +
  IV + ciphertext + tag. A piece is ≤ `MAX_CHUNK_BYTES` (32 MB, a named
  constant because it bounds the Worker's memory: 128 MB per isolate, and the
  request body limit is 100 MB on Free/Pro zones, per Cloudflare's limits page).
  30 s at the default bitrates is ~4.5 MB.

### D1 (next free migration numbers; today's last is `0082_spend_alert.sql`)

`meeting`, primary key `(user_id, id)`, index `(user_id, started_at DESC)`:

| column | |
| --- | --- |
| `id`, `user_id` | |
| `title_sealed` | default "Meeting, <date>" in the device's zone; rename seals again |
| `status` | `recording` · `ended` · `interrupted` · `deleting` |
| `started_at`, `ended_at`, `duration_ms`, `bytes` | clear, for the list and quotas |
| `mime_av`, `mime_audio`, `width`, `height` | |
| `has_mic`, `has_room_audio`, `device` | |
| `transcript` | `none` · `local` · `cloud` (the user's choice) |
| `transcript_status` | `none` · `waiting` · `running` · `done` · `failed` |
| `material_id` | the /reader copy, if he opened one (NULL otherwise) |

`meeting_chunk`, primary key `(user_id, meeting_id, track, seq)`:
`start_ms`, `dur_ms`, `bytes`, `sha256`, `frag_off`, `frag_ms`, `at`.

`meeting_line`, primary key `(meeting_id, track, start_ms)` (upserted on it;
every statement also carries `user_id`): `user_id`, `end_ms`, `speaker`
(nullable: a label such as `me`, `others` or a voice id), `lang`,
`text_sealed`, `source` (`live` | `final`), `updated_at`. Migration
`db/migrations/0083_meetings.sql`.

### The upload route

`PUT /api/my/meetings/<id>/chunks/<track>/<seq>`, raw bytes (not base64 JSON
as recordings use: pieces are megabytes). Headers: `x-lk-sha256`,
`x-lk-start-ms`, `x-lk-dur-ms`, `x-lk-frag-off`, `x-lk-frag-ms`. **Session
only**, no API token. Checks: flag, `dev`, own meeting in `recording` (or
`interrupted` within a day, for left-over pieces), track known, `seq` ≤ the
maximum, size, hash, the account quota. R2 first, then the row; a failed row
deletes the object, as recordings do. The same `seq` with the same hash
answers `{dup: true}`; a different hash is 409.

### Limits, quotas, retention — config keys (`lib/config.ts`, group `meetings`)

| key | default | what |
| --- | --- | --- |
| `meetings.chunkSec` | 30 (10–120) | piece length |
| `meetings.maxMinutes` | 180 (1–600) | longest meeting |
| `meetings.videoKbps` | 1000 | `av` video bitrate (screens compress well) |
| `meetings.frameRate` | 15 (1–30) | screen frames per second |
| `meetings.audioKbps` | 128 | `av` audio bitrate |
| `meetings.trackKbps` | 32 | `me` / `others` bitrate |
| `meetings.quotaGB` | 50 | per account; at the limit Start is refused and a running meeting stops, saying why |
| `meetings.retentionDays` | 0 = keep until deleted (0–3650) | daily sweep, as `recordings.retentionDays` |
| `meetings.staleMin` | 30 | when a silent `recording` becomes `interrupted` |
| `meetings.mimeTypes` | the table above | format preference |

The quota counts `meeting.bytes`, updated with each piece in the same batch.

### Delete

- From the list's ⋯ menu or the meeting page: one inline "Delete for good?"
  (as /my/recordings). `DELETE /api/my/meetings/<id>`, session only.
- **Immediate for the user:** the row becomes `deleting` in the same request
  and vanishes from every read. Then the Worker lists the prefix
  `meetings/<uid>/<id>/` and deletes the objects (R2 `delete()` takes up to
  1,000 keys a call), then the chunk, line and meeting rows. A delete cut short
  is finished by the daily Cron Trigger (`worker.ts` `scheduled`, beside
  `lib/recordings-sweep.ts`). Nothing polls.
- The /reader copy, if any, is deleted with it (open question 6).
- Turning the flag off deletes nothing.

### Export / download

- **Video:** `GET /api/my/meetings/<id>/download` streams the `av` pieces
  opened one at a time, end to end, as one `.mp4` / `.webm` (memory holds one
  piece, as `lib/zip-stream.ts` does for a day of clips). It plays in Chrome
  and VLC; seeking may be slow in some players, since MediaRecorder writes no
  index. `ffmpeg -i in.webm -c copy out.webm` on the Mac fixes that locally.
- **Transcript:** `…/download?part=txt` and `?part=vtt` (subtitles, so the
  video plays with them in any player).

## Playback: /my/meetings/<id>

- Media Source Extensions (`ManagedMediaSource` on iOS). The page appends the
  header bytes, then pieces from the one holding the wanted time, starting at
  its `frag_off`. That is what makes seeking work on an index-less recording.
  Behind the play head, buffered ranges are removed, so an hour never sits in
  memory.
- Pieces are served by `GET /api/my/meetings/<id>/chunks/<track>/<seq>`,
  decrypted by the Worker, `Cache-Control: private, no-store`.
- **No signed R2 URLs.** The objects are sealed, so a direct R2 link would
  hand out ciphertext; and the Worker reads R2 through its binding, with no S3
  credentials to sign with. Egress through the Worker is free (R2 pricing).

## Transcript

**Default: none.** The start page has one segmented switch (three states,
all visible, active filled red): **None** · **Lianki's speech server** ·
**Cloud**. It can be changed on the meeting page afterwards, and a transcript
runs only after a tap there or at the start.

| choice | how | who hears the audio |
| --- | --- | --- |
| None | nothing | nobody |
| Lianki's speech server (local) | the meeting page, open in the owner's browser on the tailnet, fetches each `me` / `others` piece, decodes it (`decodeAudioData`, then 16 kHz mono through an `OfflineAudioContext`) and sends it over the existing socket protocol (`begin`, PCM frames, `end` → `final`; [local-stt.md](local-stt.md), "Protocol") to `scripts/local-stt/server.py`. The lines are POSTed back as text | his Mac only. **Tailnet only**, never the `stt.lianki.com` tunnel (its TLS ends at Cloudflare's edge, as /vibe's `vibeRoute` rule says). mlx-whisper on the Mac (`stt.whisper-recheck`'s engine) is the better choice for long pieces than streaming SenseVoice; which one is decided in M4 |
| Cloud (per meeting, explicit) | the Worker opens each audio piece and sends it to Workers AI `@cf/openai/whisper-large-v3-turbo` (`lib/stt.ts`), metered like every AI call | Cloudflare Workers AI. The switch says so in plain words. This is the owner's per-meeting approval that his standing rule (recordings never to a cloud service without his approval, 2026-11-14) asks for |

- **Speaker labels:** `Me` / `Others`, from the track. Free. Telling the
  other people apart (diarisation) is not in v1.
- **Languages:** SenseVoice knows zh, yue, en, ja, ko; Whisper more. Each line
  gets its language with `detectLangs` (`lib/read/lang-detect.ts`).
- **To /reader:** an "Open in reader" button makes a `read_materials` row with
  `source: "meeting"`, by the user's tap only. It gets every /vibe privacy rule:
  in `NEVER_OFFERED` (`lib/read/polish-offer.ts`), covered by
  `isPrivateSpeech` (`lib/vibe/private-speech.ts`), no Copy link, never
  `read_translation` or `shared_books` ([vibe.md](vibe.md), "Where its text goes").
  Each reader line links back to that moment of the video (`?t=`).

## Pages

| address | what |
| --- | --- |
| `/my/meetings` | the list, newest first, in one `VirtualList` (`app/components/VirtualList.tsx` + `useInfiniteList`): continuous scroll, **no pagination**. Date in the device's zone (`zoneDay`, `lib/recordings-view.ts`), title, length, size, transcript state; ⋯ Rename, Download, Delete. Start sits at the top |
| `/my/meetings/new` | the start page: one line on what is captured, the line about other people, Copy notice, the mic switch, the transcript switch, the browser note (macOS/Linux: tab sound only), Start |
| `/my/meetings/<id>` | the player filling the screen, glass controls over it; the transcript beside it from `md` up, under it on a phone; a tap on a line seeks; Transcribe (if none), Open in reader, Download, Delete |
| `/my` | one card "Meetings", shown only where the page exists (flag + `dev`) |

UI state: the list's position is the centre row's id in sessionStorage
(`lk:ui:list:meetings`, [ui-state.md](ui-state.md)); the playback speed is a device preference
(`lk:pref:meetings-speed`, the speeds from `recordings.speeds`); the meeting
itself is server data, never in sessionStorage.

**i18n:** `my-meetings.content.ts` (intlayer, 16 locales). Every key carries
its context line, as [i18n.md](i18n.md) requires: "Recording" (the status word
in the floating bar while the screen and sound are being recorded; one word),
"Copy notice" (button that copies a sentence the user pastes into the meeting's
chat to tell the others they are being recorded), the notice itself (said by
the user, first person, to the people in a meeting), and so on.

## Security and privacy

| question | answer |
| --- | --- |
| Who can read a meeting | the signed-in owning account only. Every statement carries the caller's user id; nothing in a request names an account |
| API tokens | **no `meetings:*` scope in v1.** A token cannot list, play, download or upload. (Recordings has `recordings:read` for the pull script; meetings needs none, since the local transcript runs in his browser) |
| Dev bridge, preview | not wired to meetings (`lib/dev-bridge-user.ts` does not list the route). The preview server 404s it |
| Agents, the hub, MCP | must not read recordings. The hub never receives audio, video or transcript lines; the chat lanes, MCP and `lianki-dev` get no route to them. The meeting pages carry `data-lk-private-screen`, so the chat never sends their text as context (`packages/debug-chat/src/scene.ts`) |
| Eval | an eval session can run code on the owner's pages ([secrets-and-auth.md](secrets-and-auth.md), "Eval tokens"). The eval runtime (`DebugChatHost.tsx`) **refuses to run on `/my/meetings*`**. The honest limit: code evaluated on any other Lianki page shares the origin and his cookie, so it could still call `/api/my/meetings`. Closing that needs a passkey unlock for playback (open question 5) |
| /dev pages | counts and bytes per account at most; never titles, text or media |
| Logs | sizes, durations, status codes only (as recordings). Never a title, text or bytes |
| Other users' data | meetings are per account with no cross-account path; no admin view of content. What appears on the shared screen is the user's own choice in the browser's picker |
| CSP / Permissions-Policy | today the app pages send **no Permissions-Policy**, so camera, mic and display capture follow the default (`self`) and work at the top level of lianki.com; only mini apps send one (`lib/mini-apps/handlers.ts`: `camera=(), microphone=()…`). Changes: add `Permissions-Policy: display-capture=(self), microphone=(self)` and `Content-Security-Policy: frame-ancestors 'none'` on `/my/meetings/:path*` (`next.config.mjs` `headers`), so a meeting page can never be framed; add `display-capture=()` to the mini apps' list; `/embed/partner` (framed by any site) must never get `display-capture` |
| /privacy | the "Your voice" section (`app/(app)/privacy/page.tsx`, `#voice`) gets a paragraph: meetings are recorded only when you start one, are kept sealed in your account, and are sent to a cloud transcriber only when you choose that for a meeting |

## Cost

Sizes at the defaults: `av` ≈ 1,000 + 128 kbps ≈ **0.51 GB an hour**;
`me` + `others` ≈ 0.03 GB. About **0.54 GB per meeting-hour**.

| item | price (source) | per meeting-hour |
| --- | --- | --- |
| R2 storage | $0.015 / GB-month, first 10 GB-month free ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) | $0.008 a month while kept |
| R2 writes (class A) | $4.50 / million; ~360 pieces an hour | $0.0016 once |
| R2 reads (class B) | $0.36 / million | ≈ $0 |
| Egress | free from R2 through Workers (same page) | $0 |
| Transcript, local | the Mac's own CPU | $0 |
| Transcript, cloud | Whisper large-v3-turbo $0.000513 / audio minute ([workers-ai.md](workers-ai.md), from Cloudflare's pricing page 2026-10-29); two tracks | ≈ $0.06 once |

Example: 10 hours of meetings a week, kept forever, is ~23 GB a month of new
storage: ~$0.20 a month after the first month, ~$4 a month after a year.
The 50 GB quota caps it at $0.75 a month per account.

## Milestones (agent hours)

| # | what | est. |
| --- | --- | --- |
| M0 | flag, gate, config keys, migrations, sealing helpers + unit tests | 2 h |
| M1 | capture: streams, mix, three recorders, IndexedDB queue, PUT route, the floating bar, `/my/meetings/new`, chat-mic block, headers | 5 h |
| M2 | list, player (MSE + seek by fragment offset), download stream, delete + sweep, /my card | 5 h |
| M3 | local transcript in the page (decode → Mac socket), lines, speaker labels, VTT, Open in reader | 4 h |
| M4 | cloud transcript per meeting, metering | 2 h |
| M5 | 16 locales with context lines, /privacy paragraph, a silent QA script (Chrome's fake media flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, `--auto-select-tab-capture-source-by-title`; no real mic, no sound), docs | 3 h |
| | **total** | **≈ 21 h** |

Each milestone ships dark behind `meetings.record`; nothing is on until the
owner turns it on at https://lianki.com/dev/flags#meetings.record.

## Verified vs assumed

| claim | status |
| --- | --- |
| getDisplayMedia support, audio per browser/OS, Chrome options, no mobile Chrome/Firefox | **verified**, MDN browser-compat-data 2026-11-18 |
| user gesture required, permission never persisted | **verified**, MDN `getDisplayMedia()` |
| MediaRecorder support per browser | **verified**, MDN browser-compat-data |
| Chrome MP4 recording (126+), Safari WebM recording (18.4+) | secondary sources; feature-detected at run time anyway |
| R2 prices, Worker 128 MB / 100 MB body | **verified**, Cloudflare docs 2026-11-18 |
| `dataavailable` keeps firing on schedule while the Lianki tab is hidden | **assumed**, test in M1 |
| each MediaRecorder piece has a fragment start that MSE can append from | **assumed**, test in M2 (else seek = append from the start) |
| an iPhone plays the chosen `av` format through ManagedMediaSource | **assumed**, test in M2 |
| Workers AI Whisper accepts a WebM/Opus piece as is | **assumed**, test in M4 (else decode to WAV in the browser first) |

## Open questions for the owner (each with my default)

| # | question | default if no answer |
| --- | --- | --- |
| 1 | Your meetings: browser tabs (sound works on the Mac) or the native Zoom/Teams app (no sound of the others on macOS)? | design for browser tabs; the start page explains the native-app limit |
| 2 | Keep meetings until deleted, or a retention? | keep until deleted (`meetings.retentionDays` 0), capped by the 50 GB quota |
| 3 | The line to other people: a plain line + Copy notice, or a checkbox you must tick each time? | plain line + Copy notice, no checkbox (as /vibe) |
| 4 | Transcript default for a new meeting | None; Lianki's speech server one tap away; Cloud only when chosen per meeting |
| 5 | A passkey tap to open or download a meeting (closes the eval gap above)? | yes: one passkey tap unlocks playback for 30 minutes on that device; recording itself needs none |
| 6 | Delete a meeting → also delete its /reader copy? | yes, both, said in the one confirm line |
| 7 | Video quality: 1 Mbps, 15 fps (~0.5 GB/h) | as stated; config keys if you want sharper |
| 8 | Later, other users? | no until you say; v1 is your account with `dev` only |

## The API for the transcript side (M3/M4; built in M0–M2)

All routes: session only (a request with an `Authorization` header is 404), the
`dev` grant and flag `meetings.record`, else 404; 503 off D1. Errors are
kebab-case codes. `<track>` is `av`, `me` or `others`; `<seq>` 0…3600.
Logic in `lib/meetings/store.ts`, tests in `unit/meetings.test.ts`.

| route | what |
| --- | --- |
| `GET /api/my/meetings/<id>/chunks[?track=me]` | `{chunks: [{track, seq, startMs, durMs, bytes, fragOff, fragMs}]}`, by track then seq |
| `GET /api/my/meetings/<id>/chunks/<track>/<seq>` | the piece, opened, `content-type` its MIME type, headers `x-lk-start-ms`, `x-lk-dur-ms`; `Cache-Control: private, no-store` |
| `PUT /api/my/meetings/<id>/chunks/<track>/<seq>` | the recorder's upload (above) |
| `PUT /api/my/meetings/<id>/lines` | body `{source: "live" \| "final", lines: [{track, startMs, endMs, text, speaker?, lang?}], replace?: {track, startMs, endMs}}`; ≤ 200 lines, text ≤ 2,000 chars, body ≤ 512 KB |
| `GET /api/my/meetings/<id>/lines` | `{lines: [{track, startMs, endMs, speaker, lang, text, source, updatedAt}]}` in time order |

**Times.** `startMs` / `endMs` are ms from the meeting's start, on the
recorder's one clock (the `AudioContext` that captures every track); a piece's
`startMs` is on that clock too.

**Line rules** (one D1 batch per PUT, so all or nothing):

1. With `replace`: that track's rows whose `start_ms` is in `[startMs, endMs)`,
   live and final, are deleted first. `lines` may be empty (a span cleared).
2. Without `replace`, a `final` PUT deletes, per track, every `live` row
   whose `[start_ms, end_ms)` overlaps its lines' span `[min startMs, max endMs)`.
3. Every line is upserted on `(meeting_id, track, start_ms)`. A `live` line
   never overwrites a stored `final` at the same key.
4. `GET` returns every final, plus only the live rows that no final of the
   same track overlaps.

**Live PCM hook** (for live captions; `lib/meetings/capture.ts`). While a
meeting records, `meetingRecorder().onPcm(f)` calls
`f({track, offset, samples})` for `me` and `others`: `samples` is a
`Float32Array` of 16 kHz mono PCM and `offset` its first sample's index from
the meeting's start (so `offset / 16` is ms on the same clock as lines and
pieces). Returns the unsubscribe. No speech recogniser is wired here.

**Pieces of `me` and `others`** are each a complete, decodable file: a new
MediaRecorder per piece, started at each `av` piece.
