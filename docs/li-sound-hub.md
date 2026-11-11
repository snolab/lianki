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
