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

**The server never fetches a src** (no SSRF). The hub sends the main Worker
only the host and the kind (`DebugSessions.playAudio`, `lib/play-check.ts`),
which answers yes or no: the flag on; the host not denied; for a lane token,
`chat:play` and a `dev` holder's account (the flag's audience, a permission,
not an email); per token (or per sender on the grant path) at most
`chat.play.perTenMin` audio lines in 10 minutes (default 20, D1-counted).
Every allowed one is in `security_audit` as `chat.play` (actor: the token's
account or `grant`; subject: the host; detail: the kind and the token's name
or the sender). A refusal goes back to the sender with what to do (the flag
link, the config key, the permission); an older main Worker or a failed call
refuses.

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
  the page's one `<audio>` element (HLS only where the browser plays it
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
