# Li's sound hub: all sound goes through Li

The owner, 2026-11-07 19:00 JST: 「我们的所有声音相关的功能都应该通过你实现」 — every
feature that listens or plays goes through Li. This is done in phases; each
one ships dark behind the flag **`voice.li-hub`** (owner only, default off,
<https://lianki.com/dev/flags#voice.li-hub>).

## What exists today (what the hub will replace)

| kind     | piece                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| mic      | the chat mic `__lkMic` (`mic-session.ts`, `mic.ts`, `MicButton.tsx`)                        |
| mic      | command taps `__lkMicTaps` (`mic-taps.ts`): /words voice mode (`lib/words/voice-mic.ts`), /vibe's block |
| mic      | `pageAudio().listen` (`page-audio.ts`): /reader's shadowing, fed by the chat mic              |
| mic      | /vibe's own capture (`lib/vibe/browser.ts`, through `voiceCapture()`)                       |
| sound    | Li's voice (`voice.ts`, `voice-out.ts`), /words read-aloud (`WordsClient.tsx`), the reader (`lib/read/speaker.ts`) |
| sound    | `cues.ts`, `output-bed.ts`, `gradeSound.ts`, polyglot's and self-intro's `<audio>`          |
| who wins | `audio-claim.ts` events ([dev-debug-widget.md](dev-debug-widget.md), "Page audio owner"), `__lkPageAudio` |

## Phase 0: observe only (shipped dark)

`packages/debug-chat/src/li-audio.ts` is the hub, one per page on
`globalThis.__lkLi`, versioned (`LI_V`) like `__lkMic`: a newer bundle retires
an older hub, and an older bundle never replaces a newer one. Its state is
derived from the sources, so a new hub starts from what they say now.
`li-client.ts` starts it and sends what it sees to `wrangler tail lianki`
through `devLog` (so only in debug mode):

- `{ev: "audio-owner", mic, pinned, captures, claim, playing, page}` on each
  change (an unchanged view is not sent again);
- `{ev: "audio-conflict", kind, ...view}` when a collision begins (not again
  until it ends): `two-captures` (two live mic streams, or the chat mic on while
  /vibe owns the room) or `overlap` (two sinks sounding at once).

**What it reads, and how:**

| field      | source                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `mic`      | `chat`: `pageAudio().mic()` or the `__lkMic` view not `off`; `vibe`: `__lkMicTaps.blocked()`         |
| `pinned`   | `__lkMicTaps.pinned()` (/words voice mode)                                                          |
| `captures` | every `getUserMedia` asking for audio while any audio track is `live` (stopped streams drop at the next change) |
| `claim`    | the last `lk:audio-claim` nobody cancelled, until its `lk:audio-release`                            |
| `playing`  | media elements (in the page or `new Audio()`) from `playing` to `pause`/`ended`/`emptied`/`error`; `speechSynthesis` utterances from `start` to `end`/`error` |
| `page`     | `pageAudio().playing()`                                                                             |

**Pass-through.** Flag off: DebugEval never even loads `li-client`; nothing
is wrapped, nothing listens. Flag on (owner's pages only, `owner && !friend`):
`getUserMedia`, `HTMLMediaElement.prototype.play` and `speechSynthesis.speak`
are wrapped to call the original with the same `this` and arguments and
return its result unchanged (the same promise). The hub never cancels a
claim, never creates `__lkMicTaps` (it reads it only if a page made it) and
touches no DOM. Retiring takes a wrapper off only while it is still the hub's.

**Not seen in phase 0:** Web Audio sounds (`cues.ts`, `output-bed.ts`,
`gradeSound.ts`); which caller opened a capture (the view says who holds the
mic, not whose stream is whose); a stream stopped with nothing else changing
is counted until the next change; /reader's shadowing listener (it uses the
chat mic, so it is not a separate capture).

**Tests:** `unit/li-audio.test.ts` (fakes only: no mic, no sound): flag off
touches nothing; on, wrappers pass through and come off; audio-claim order is
unchanged; owner lines, overlap and two-captures conflicts; the registry's
versioning.

## Next phases (not built)

1. Callers move one at a time: each sound asks the hub instead of claiming
   by itself; each mic user asks the hub for a capture.
2. The hub decides: one capture per page, one sink at a time by rank, the
   cues and the bed included.

## Pronunciation table

Owner, 2026-11-11: Li read "WebRTC" wrongly. Terms now have a spoken form,
applied to the text before **any** engine in Li's read-aloud — the device's
speechSynthesis and the cloud alike — and only to what is spoken: the chat
line on screen keeps the written term.

- **Data, not code.** The table is the config key **`voice.lexicon`**
  (`lib/config.ts`, a JSON list edited at
  <https://lianki.com/dev/config#voice.lexicon>, live within 30 s, no
  deploy). Each entry is `{term, say, lang?, ignoreCase?, ph?, alphabet?}`.
  The code default (`DEFAULT_LEXICON` in
  `packages/debug-chat/src/lexicon.ts`) seeds WebRTC, API, MCP, Tailscale,
  iOS, PWA, STT, TTS, URL, JSON, GitHub, npm, CLI and Lianki.
- **One matcher for every language.** An entry without `lang` is for every
  language; with one (`zh`, `ja`, `zh-TW`) it applies to that language and
  its locales, and per term the most specific entry wins (zh-TW over zh over
  none). No per-language code.
- **Whole words.** An ASCII letter, digit or `_` next to the term means it is
  part of a longer word ("APIs", "API_KEY" are left alone); punctuation and
  CJK neighbours are edges ("用WebRTC连接"). Case-sensitive unless the entry
  says `ignoreCase`. One pass, longest term first, so a spoken form is never
  replaced again.
- **Where.** `voice.ts` `toSentences`: sentences are cut from the written
  text, then each is put in its spoken form (`speakForm(text, lang)`) and
  chunked. The table reaches the page from the root layout
  (`cfg("voice.lexicon")` → `OwnerBoots` → `DebugEval` → `setLexicon`, kept
  on `globalThis.__lkLexicon` so a hot-loaded chat reads the same one); an
  invalid table leaves the default in place.
- **Per-language runs (PR #502, not merged).** `speakForm` is a pure function
  of (text, language), so it applies per run as well: call it on each run with
  the run's language, or on the sentence before it is cut into runs.
- **SSML engines.** `ph` (IPA, or X-SAMPA with `alphabet`) is for engines that
  read SSML: `toSsml` writes a term as `<phoneme>` when it has one, else as
  `<sub alias>` with its spoken form.
- **Not covered.** /reader's read-aloud tracks the reading position by
  character offset, so it still reads the written text; /words reads single
  words and examples from recorded clips.
- Tests: `unit/lexicon.test.ts`.

## Provider voices

Owner, 2026-11-11: Taiwan Mandarin and Taiwanese (Hokkien) voices. No
Workers AI voice has either, and his Android has no speechSynthesis voice at
all, so these are made **on the server** and played by the chat's cloud
`<audio>` (`voice-out.ts`), like MeloTTS.

- **Ids, as data.** A line may name `google:<voice>` (any Google Cloud TTS
  voice name, e.g. `google:cmn-TW-Wavenet-A`) or `azure:<voice>[/<locale>]`
  (an Azure Speech voice, optionally reading in a secondary locale, e.g.
  `azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN` — Southern Min with a mainland
  accent; neither provider has a Taiwanese `nan-TW` voice). One strict parser
  (`voices.ts parseLineVoice`) for `say --voice`, the hub and the page.
- **Language → voice** is the config key `voice.langVoices` (/dev/config;
  default `zh-TW → google:cmn-TW-Wavenet-A`, `nan → azure:…/nan-CN`). A line
  with no voice of its own uses the map's voice for its language (locale
  first, then the language). Han text is detected as `zh-CN`, and Taiwan
  Mandarin or Taiwanese cannot be told from the characters, so `zh-TW` / `nan`
  apply only to a line that names them; add `zh` to read all Chinese in one.
- **Code per provider, never per language** (`lib/cloud-voices.ts`): Google
  `text:synthesize` (JSON, MP3) and Azure's REST endpoint (SSML, MP3, region
  from the config key `voice.azureRegion`, default `eastasia`). The text goes
  as SSML with the pronunciation table written as `<sub>` / `<phoneme>`
  (`toSsml`), so `ph` entries are honoured here.
- **Route:** `GET /api/voice/tts?voice=&text=` (`lib/cloud-voices-handler.ts`):
  signed in, flag **`voice.cloud-voices`** on and the `dev` grant (audience
  owner; otherwise 404), text 1–200 characters, 300 sentences per 10 minutes,
  `no-store`, nothing kept in R2.
- **Paid** from the user's credits, feature `voice.cloud` (docs/payments.md):
  the tier's list price per million billed characters × `MARGIN` × 150
  credits/USD, the same for every account, admin included. Settled charges
  appear on /dev/costs (paid side) and /membership/credits ("voice").
- **Inert without keys.** No key: 503 `X-Voice: not-configured`, nothing held.
  Any failure (no key, a provider error, out of credits, the flag off) and the
  page reads the sentence in the line's lane voice (MeloTTS / Aura), else
  speechSynthesis: never silence. With the flag off the page never asks.
- **Secrets** (Worker `lianki`, names only; read only in
  `lib/cloud-voices.ts`, sent in a header, never logged):
  `GOOGLE_TTS_API_KEY` — a Google Cloud API key restricted to the Cloud
  Text-to-Speech API only, in a project with a budget alert and a daily
  request quota; `AZURE_SPEECH_KEY` — key 1 of an Azure AI Speech resource in
  the region `voice.azureRegion` names, used for nothing else.
- **Preview:** `lianki-dev say --voice google:cmn-TW-Wavenet-A "…"` posts to
  his thread; his phone plays it. The Mac and the tests never play it.
- Tests: `unit/cloud-voices.test.ts` (parser, requests, prices, the route with
  fakes), `unit/cloud-voices-page.test.ts` (the page: map, fallback).

## Synchronized read-aloud

The owner, 2026-11-14 20:2x JST: when two of his devices both read Li's
lines aloud, they start the same line at the same instant — 「快的设备可以稍微等那么几毫秒，等慢的设备也收到了消息」.
About 200 ms of skew is fine. Flag **`voice.sync-speak`** (audience owner,
default on; <https://lianki.com/dev/flags#voice.sync-speak>); code in
`packages/debug-chat/src/sync-speak.ts`, tests in `unit/sync-speak.test.ts`
and `unit/debug-hub-sync-speak.test.ts`.

- **Clock.** Each page sends `{type:"clock", t0}` over the chat socket when
  it opens (`CLOCK_ROUNDS` pings, one after another's answer); the hub
  (`workers/push/src/debug.ts`, `fromPage`) answers `{type:"clock", t0, t1,
  t2}` with its own time. offset = ((t1 − t0) + (t2 − t3)) / 2; the
  lowest-RTT samples are kept and the best one is used. A stamped line that
  finds the estimate older than `CLOCK_REFRESH_MS` starts a new round (no
  timer). The estimate lives on `globalThis.__lkHubClock`.
- **Stamp.** The hub adds `speakAt` = hubNow + `voice.syncLeadMs` (config,
  default 300) to each agent `chat` frame and each `edited` frame (the polish
  read-back), to his pages only — never stored, never sent to a lane — and
  only while at least two of his _devices_ are connected (`syncDevices`:
  distinct device ids; two tabs on one Mac are one device, and only one of
  them reads anyway). The flag and lead are read in the background (cached a
  minute) so no line waits for the main Worker; unread, busy or off = no
  stamp.
- **Wait.** `DebugEval` turns `speakAt` into a local `startAt` (`syncWait`):
  a page early waits until then, a page already past it starts at once, and
  none waits more than `voice.syncMaxWaitMs` (config, default 1500). Li's
  queue (`voice.ts` `next()`) holds the line's first sentence until
  `startAt`; the output-bed pre-roll runs inside that wait. A start later
  than `voice.syncSkewMs` (default 200, the tolerance the tests assert) is
  logged as `voice-sync` with `late`, so the lead can be raised.
- **Tolerant.** `speakAt` is optional: a page built from main (the widget
  hot-loaded on it), an older hub that never answers a ping, or a page with
  no estimate yet simply reads at once, as before.
## Playing audio from an agent

The owner, 2026-11-11 20:20 JST: "ensure we are able to play any audio stream
by agent". Phase 1 ships dark behind **`chat.play-audio`** (audience owner,
default off, <https://lianki.com/dev/flags#chat.play-audio>).

```bash
lianki-dev say --play https://cdn.example.com/lesson3.mp3 --title "Lesson 3" "listen to this"
lianki-dev say --play https://radio.example.org/live.m3u8 "the station"     # HLS: kind stream
lianki-dev say --play file:0123456789abcdef0123 "your recording"           # from My Files
lianki chat say --play https://ice.example.net/stream --kind stream "live"  # a lane token (chat:play)
```

**The line.** The hub stores `audio: {src, kind, mime?, title?}` on the chat
line (`wire.ts` ChatMessage.audio). `kind` is `file | stream | rtc | gen |
webaudio`; the wire takes `file` and `stream` today and refuses the others by
name. One parser, `play-audio.ts parsePlay`, is used by eval.ts, the public
CLI's shape check, the hub, the token path and the page (a stored line is
parsed again before its chip shows).

**What a src may be.** `https://` only; no user name or password in it; a
named public host (never an IP literal in any spelling, never `localhost`,
`.local`, `.internal`, `.lan`, `.home.arpa` or a one-label name); not on the
deny list (config `chat.play.denyHosts`, empty by default: "any stream" means
no allowlist). `file:<20 hex>` is a My Files id. The kind is guessed from the
path: an audio extension is `file`, `.m3u8` is a `stream` with the HLS type,
anything else (Icecast `/stream`) is a `stream`; `--kind` overrides.

**The server never fetches a src**, so this path does not create server-side
SSRF. The owner's browser does request the URL: the remote host can see the
device's network address, and browser media/CORS policy and supported codecs
still apply. The hub sends the main Worker only the host and the kind
(`DebugSessions.playAudio`, `lib/play-check.ts`), which answers yes or no: the
flag on; the host not denied; for a lane token,
`chat:play` and a `dev` holder's account (the flag's audience, a permission,
not an email); per token (or per sender on the grant path) at most
`chat.play.perTenMin` audio lines in 10 minutes (default 20, D1-counted).
Each authorization and line post is recorded in `security_audit` as
`chat.play` (actor: the token's account or `grant`; subject: the host; detail:
the kind and the token's name or the sender). This records permission to post,
not proof that a browser loaded or played the audio; the page's `devLog` has
the playback outcome. A refusal goes back to the sender with what to do (the
flag link, the config key, the permission); an older main Worker or a failed
call refuses.

**My Files.** The page asks `POST /api/my/files/<id>/play` (its own session,
same origin, the My Files gate and the flag): for the user's own audio file,
a URL `…/play?exp&sig`, HMAC-signed (owner, file, expiry; a key derived from
`AUTH_SECRET` with its own label), valid one hour. `GET` on it serves the file
inline with byte ranges (iOS asks for ranges while it plays); expired, forged,
another file's signature or a non-audio file: 404 (`lib/import/play-url.ts`).

**On the page.** With the flag on and the viewer holding `dev` in their own
thread, a line with audio shows its ▶ chip (`PlayChip.tsx`): play/pause, stop,
the title, a progress bar for a file or a "Live" badge for a stream, and a
line in words when it is not playing by itself. It plays **by itself** only
when all hold (`autoplayDecision`): a live line (not history), not a desktop
(`isDesktop()`: his Mac never plays by itself), the tab that reads replies
aloud, not `--quiet`, the page visible, his mic off, and the player already
unlocked (a tap on this page primed its element, or the browser says the page
was activated). Otherwise the ▶ waits for a tap and says why ("🔊 Tap to
play", "The mic is on: turn it off to play"). A browser refusal
(NotAllowedError) is the same tap, never silence; a load failure or a stream
the browser cannot play says so. Volume is never touched.

**Li's player** (`li-player.ts`, `globalThis.__lkLiPlay`, versioned) is the one
way line audio plays, every kind through the same object, so they share the
controls, the rules and the log:

- **sources by kind**: `register(kind, source)`; `file` and `stream` play on
  the page's one `<audio>` element when supported (HLS only where the browser plays it
  itself: Safari, iOS; elsewhere "this browser can't play this stream");
- **the page's audio owner**: it claims as `AUDIO_PRIO.play` (2, a card's rank):
  Li's voice (3) pauses it and it goes on after; it pauses the reader's
  paragraph (1); a newer equal claim wins. A line whose caption Li reads
  plays right after the caption;
- **the mic**: a play with his mic open is held with the reason; the mic
  opening (the `__lkMic` session, or /vibe's room) pauses it;
- **the log**: `devLog` `{ev:"play", id, outcome, host, kind}` and
  `{ev:"play-auto", play, why}` (host only, never the URL).

**Tests** (fakes only; nothing plays): `unit/play-audio.test.ts` (the src
check, the autoplay decision), `unit/li-player.test.ts` (the player on a fake
element: blocked → tap, mic, Li's claim, sources, file URLs),
`unit/play-chip.test.ts`, `unit/play-check.test.ts` (flag, deny list, scope,
rate, audit; the token path through the hub), `unit/debug-hub.test.ts`
("say --play"), `unit/play-url.test.ts`, `unit/play-cli.test.ts` and
`unit/lianki-cli.test.ts` (the flags).

### Next phases (not built)

The kinds are already in the type and the player takes a source per kind, so
none of these changes the line or the chip.

2. **`rtc`: a live stream over WebRTC** (the voice lane owns WebRTC,
   [local-stt.md](local-stt.md), "His own Mac over WebRTC"): an Opus track
   from the Mac to the phone on the existing peer connection (today a
   DataChannel only). Its source attaches the track to the element
   (`srcObject`); the mic rule matters most here (echo).
2. **`gen`: a server-generated stream**: ffmpeg or a TTS engine on the Mac or
   a Worker produces audio as it goes, delivered as HTTP chunked audio or HLS
   (then it plays like a `stream`), or as a WebRTC track through the voice
   lane (then like `rtc`). The hub still never fetches it; the page does.
3. **`webaudio`: the phone builds the sound** in WebAudio from a declarative
   recipe on the line (tones, envelopes, sample sequences, several sources
   mixed): data only, read by one fixed interpreter in the bundle. Code from
   the wire never runs; anything beyond the recipe goes through the eval
   grant as today.
- hls.js for HLS where the browser has no native HLS (Chrome on Android,
  desktop Chrome): a source registered for `stream` with the HLS type.
