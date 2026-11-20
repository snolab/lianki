# Echo suppression: our own voice is never his words

**Status: M1–M3 built** (owner "go", 2026-11-20 ~16:00 JST, with the
defaults under "Open questions"); M4 (the self print) and later are not.
Code: `echo.ts` `echoGuard` (layer (a)), `play-report.ts` (the page's
reports), `lib/echo-reports.ts` (the hub's store, match and verdict),
`workers/push/src/debug.ts` `echo()`, `echo-rows.ts` / `EchoRows.tsx` (the
rows). Tests: `unit/echo-guard.test.ts`, `unit/play-report.test.ts`,
`unit/echo-reports.test.ts`, `unit/debug-hub-echo-reports.test.ts` (with the
14:25 replay), `unit/echo-rows.test.tsx`.

What was built differs from the text below in these points:

- The voice line's span on the hub's clock comes from the page (`hubSpan`
  on the chat frame, `play-report.ts` `hubSpanOf`) when it knows the
  offset; otherwise the hub moves the line's own timing by its receive time
  (`t_sent − t_speechEnd`), which needs no clock at all.
- A strong `me` is the Mac's `me` with signed proofs over these words
  (`trust: "signed"`); the per-band margin (`stt.selfMeMargin`) waits for M4.
- The snapshot is a separate `echoes` frame sent once on connect, not part
  of the `state` broadcast (50 lines on every presence change is too much).
- Private screens send hashed n-grams (`g2`, `g3`); every other report sends
  plain text, as open question 4 recommends.

The owner, 2026-11-19 ~14:25 JST (voice):
his phone read an agent's line aloud, a mic heard it, and
"先放一个占位首页，通过 GitHub Actions 自动部署…" (the agent's own words) was
posted as if he had said it. He wants:

1. **Cross-device echo cancellation.** While any of his devices (phone, Mac,
   iPad) plays Lianki speech (Li reading agent or Li lines, word audio, the
   reader), no mic on that device or another one posts that speech as his.
2. **Our playback voice as a voiceprint.** A line recognised as one of our
   own TTS voices is still shown, but **collapsed**, labelled as read-aloud
   echo, and never treated as his instruction: no lane hand-off, no Li reply.

Two words used below, kept apart on purpose:

- **sound hub** = the page's `__lkLi` (`packages/debug-chat/src/li-audio.ts`,
  [li-sound-hub.md](li-sound-hub.md)), one per page;
- **chat hub** = the Durable Object in `workers/push/src/debug.ts`, which every
  one of his pages and every lane talks to.

## What exists today

Most of the pieces are there. The gap is that they do not talk to each other.

### Who plays what, where

| sound                         | code                                                                   | text known?                                              |
| ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Li reading a line             | `voice.ts` queue → `voice-out.ts` (speechSynthesis or cloud `<audio>`) | yes: each sentence, `said` (`{text,start,end}`, last 50) |
| the polish read-back          | same queue, in his **clone** voice (`CLONE_SPEAKER`)                   | yes                                                      |
| `say --play` audio            | `li-player.ts` (`__lkLiPlay`)                                          | no (a file or stream)                                    |
| /reader read-aloud            | `lib/read/speaker.ts` → `pageAudio().start({text, always})`            | yes                                                      |
| /words word and example audio | `WordsClient.tsx` → `pageAudio().start()` (line ~1352, **no text**)    | no                                                       |
| cues, the bed, grade sounds   | `cues.ts`, `output-bed.ts`, `gradeSound.ts` (Web Audio)                | not speech                                               |

- Phones read live lines by themselves; **the Mac never autoplays line audio**
  (`li-player` `autoplayDecision`: `isDesktop()`), but its chat does read
  replies aloud when the speaker toggle is on and the mic has been used there
  (`voice.ts` header, "sticky voiced").
- **Two devices read the same line together** when both are connected
  (`sync-speak.ts`, flag `voice.sync-speak`): the chat hub stamps `speakAt`
  on agent frames, so it already knows _roughly_ when each line starts.
  It does **not** know when a line ended, which sentence a page is on, or
  that a page skipped a backlog (`backlogSkip`). The chat hub's own words:
  "the pages do not report what was read when" ([dev-debug-widget.md](dev-debug-widget.md), "Echoes").
- The sound hub sees every `play()` and `speechSynthesis.speak()` on the page
  (phase 0, observe only, flag `voice.li-hub`, default off), but it does not
  send anything to the chat hub beyond `devLog`.

### How a mic line is made

```
mic (getUserMedia, AEC on by default: aec.ts AEC_CONSTRAINTS)
 → Silero VAD (mic.ts) → utterance
 → Mac: wss …/lianki-stt → server.py SenseVoice   (else /api/debug/stt, Whisper)
        └ CAM++ (voiceprint.py): speaker {decision me|other|unknown, score, voice}
          + speakerProof (Attestor.sign over the text)
 → page guards (MicButton.tsx upload):
     voice.echoCheck (Dice ≥ 0.6, last 10 s)  or  duplexHeard (talk-over)
     pageAudio().heard / said (reader shadowing, reader echo)
 → chat hub (debug.ts "chat", source "stt"):
     repeatGuard → verifySpeakerProofs → echo() → merge → twoMic → post()
     post() → pages, listeners (lanes), token listeners, D1 history
     then ownerAi.line (Li may answer), autoPolishSoon
```

### The echo guards we already have

| guard             | where                                                | matches against                                                                  | window                                                    | kill switch              |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| **AEC**           | browser, same device                                 | the page's own output                                                            | live                                                      | `lk:voice-aec`           |
| **text guard**    | page, `echo.ts` `echoScore`                          | sentences this page played                                                       | 10 s (`ECHO_WINDOW_MS`), Dice 0.6                         | none                     |
| **talk-over**     | page, `voice.ts` `duplexHeard`                       | sentences playing at that time ±600 ms                                           | containment 0.6                                           | `voice.talk-over`        |
| **chat hub echo** | `lib/echo-match.ts` `echoMatch`, `debug.ts` `echo()` | agent lines (not `quiet`) landed in the last 60 s; his lines from another device | `voice.echoReadWindowMs` 60 s, `voice.echoSimilarity` 0.8 | `voice.echo-dedupe` (on) |

An echo the chat hub catches is **hidden**: kept aside as `echo:<id>` (newest
50), never shown, logged `debug.echo`, restorable by `unmerge`.

### Why 14:25 still got through (to confirm in M0)

No production data was read for this doc. The likely holes, from the code:

1. **Time is guessed, not known.** The chat hub's window runs from when the
   agent line _landed_, 60 s. A long reply, or one queued behind others, is
   read later than that. After 60 s nothing matches.
2. **0.8 is strict for mixed-language STT.** "GitHub Actions" inside Chinese
   comes back as anything ("get hub action", "吉他 action"). A few such words
   in a 25-character line put the edit-distance similarity under 0.8. And the
   chat hub compares with the _written_ text, while TTS spoke the
   `speakForm` text ([li-sound-hub.md](li-sound-hub.md), "Pronunciation table").
3. **The page guard uses Dice on the whole sentence** (`echoScore`, outside
   talk-over), so a fragment of a long sentence scores low. Only
   `duplexHeard` uses containment.
4. **Only 40 lines are scanned** (`ECHO_SCAN`). A busy minute of lanes can
   push the read line out.
5. **The page cannot see the other device's playback at all.** Only the chat
   hub's text match covers cross-device, with hole 1.

M0 checks which one it was from `debug.echo` / `voice-utt` logs.

## Layers, cheapest first

Each layer only adds evidence. The chat hub combines them into one verdict
per line (below). Nothing here stores audio.

### (a) Same device: AEC and the mic hold

What it is: the browser's own echo canceller (`echoCancellation: true`) and,
with AEC off, the half-duplex hold (`voice.ts` `hold`, `page-audio.ts`).

Changes:

- **Route all speech through the page's audio** so AEC hears it. Cloud
  `<audio>` and Web Audio are inside the canceller's reference; whether
  `speechSynthesis` is depends on the browser and must be measured per
  device (M5). If Android's is not, prefer the cloud voice while the mic is
  open there (a config key, below).
- **Switch the page text guard to containment** (`echoContained`, as
  `duplexHeard` does) and give it the time window from `said`, so a fragment
  of a long sentence is caught on the device that played it.
- **/words passes the text** to `pageAudio().start({text})`, so word audio
  joins the guard (the word, or the example sentence).

|            |                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------ |
| accuracy   | AEC removes most same-device echo; misses on loud speakers, Android `speechSynthesis`, Bluetooth |
| latency    | none (in the audio path)                                                                         |
| cost       | ~2 agent hours for the guard changes                                                             |
| fails when | the echo comes from **another** device (AEC never had its reference)                             |

### (b) Cross-device: "device X is speaking T from t0 to t1"

The core fix. Each page tells the chat hub what it plays, as it plays it.

**The report.** One small frame per sentence, event-driven (the voice
session's own start/end events, no timer):

```
page → chat hub  {type:"playing", ref, text, voice, from, to?}
                 {type:"played",  ref, to}
```

- `ref`: the line id and sentence index for Li's queue; a hash for /reader
  and /words.
- `text`: the **spoken form** (`speakForm` output), the words the room hears.
- `voice`: which voice read it (`device`, `melo`, `aura`, `google:…`,
  `clone`) — layer (c) uses it, and the clone matters (below).
- `from`/`to`: hub clock, from the page clock plus the offset sync-speak
  already estimates (`__lkHubClock`). A page with no estimate sends its own
  time and the chat hub widens the slack.
- Sent from the voice session (`voice.ts` where `said.push(rec)`), the
  reader (`speaker.ts`), /words (`pageAudio().start`). Later the sound hub
  sends them for everyone, once callers move to it (phase 1).

**The chat hub keeps them in memory only**, per thread, the last
`voice.echoPlayKeepMs` (default 120 s), never in storage, never sent to a
lane, never logged with text.

**The match.** For each of his voice lines, before `echo()`:

1. Candidates: reports whose `[from − slack, to + slack]` overlaps the
   utterance's span. The line already carries it in `timing`
   (`t_speechStart`, `t_speechEnd`, page clock, `wire.ts` `VoiceTiming`);
   the page adds its hub-clock offset so the chat hub can line them up.
   Slack `voice.echoSlackMs` default 1500 (room, output latency, clock error).
2. Text: `containedSimilarity` (`lib/echo-match.ts`) of the transcript inside
   the candidates' text, joined in order, against both the written and the
   spoken form. With a time overlap the line is lower,
   `voice.echoPlaySimilarity` default **0.6**; with no report, the old rule
   (landed within 60 s, 0.8) stays as the fallback.
3. Optional n-gram check for long lines: share of the transcript's character
   bigrams (CJK) / trigrams found in the candidates (`echoContained`), so
   one wrong word in ten does not save an echo.

|            |                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| accuracy   | high for anything we read with known text; time + text together rarely hits his own speech                                      |
| latency    | edit distance on ≤600 × ≤4000 chars: a few ms in the Worker; one frame per sentence                                             |
| cost       | ~6 agent hours (frames, clock, matcher, tests)                                                                                  |
| fails when | a device that plays is not connected to the chat hub; audio with no text (`say --play`, a stream); STT so wrong nothing matches |

**He repeats a line on purpose.** Outside the play window: his, as now.
Inside it (reading along): echo, but **collapsed, not lost** — one tap
"This was me" posts it (the existing `restoreEcho`). A clear `me` from the
voiceprint (signed proof, score over its band's "me" line plus
`stt.selfMeMargin`) overrides the text match, **except** when the playing
voice was `clone` (his own cloned voice scores as him).

**Overlapping speech.** He talks while Li reads: if the Mac split the final
at the speaker change (`parts`), each part is judged by itself. A final that
mixes both and is not split is kept as his line (the containment falls
under the line), with the read words still in it: a known cost, as in
talk-over today.

### (c) Acoustic: a "self" voiceprint of our TTS voices

The Mac already scores every final with CAM++ and already has more than one
print: his, and household prints (`<device>.<model>.other-<name>.json`,
`household-print.py`, the margin rule `decide_margin`). A **self print** is
one more of the same kind, made from our voices.

- **Enrol from generated speech only.** A script on the Mac (like
  `household-print.py`) asks our own TTS routes for ~40 neutral sentences per
  voice in each language we read, writes the clips to a temp dir, embeds
  them, writes embeddings only to `self-<voice>.<model>.json` (0600), and
  deletes the clips. No recording of any person. Cloud voices first (MeloTTS,
  Aura, the Google/Azure voices in `voice.langVoices`); those cost credits
  (`voice.cloud`), a few cents per voice.
- **The channel.** Our voice reaches the mic through a phone speaker and a
  room. Clean TTS embeddings are not that. The script also stores copies run
  through the existing channel simulations (`noisy.py`: phone band, dull,
  room noise), and M4 measures the real gap.
- **Device voices.** iOS/Android `speechSynthesis` cannot be recorded from
  the browser. macOS has many of the same voices and `say -o file` writes a
  file **without playing anything**; Android's Google voices have no such
  path. Until measured, a device voice relies on layers (a) and (b).
- **The decision.** `decide` gains `"self"`: the best self print scores over
  `SELF_ACCEPT` and over his print by `SELF_MARGIN`. `SpeakerDecision` in
  `wire.ts` becomes `me | other | unknown | self`, signed like the others
  (`Attestor.sign`), so a page cannot fake it. `combineSpeaker`: any `self`
  part with no `me` part makes the line `self`.
- **Never learned from.** A `self` final, or any final with `playback: true`
  (already sent on `end`), never feeds progressive learning (`server.py`
  already skips `u.playback`).

|            |                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| accuracy   | unknown until M4. Signs: `voice-filter-eval.py` stopped 88 % of TTS clips against his print at 0.15; a synthetic voice is very self-similar                                                                          |
| latency    | one more cosine per print: < 1 ms                                                                                                                                                                                    |
| cost       | ~5 agent hours + a few cents of TTS                                                                                                                                                                                  |
| fails when | the **clone** voice (built to sound like him: never enrolled as self, so it is never "self"); short finals (< 1.5 s are `unknown` anyway); the cloud route (no Mac, no check); a new provider voice not yet enrolled |

The clone is the hard case: layer (c) cannot help, and must not (a clone
print would also match him). The clone only reads his own polished lines
back, which layer (b) knows by line id.

### (d) Optional: reference-signal AEC on the Mac

For audio whose bytes the Mac can get: cloud TTS (the same `/api/words/tts`
or provider URL the phone played) and `say --play` files. When a report
says "device X played clip C from t0", the Mac fetches C once and
cross-correlates it (GCC-PHAT) with the incoming utterance; a strong peak at
a plausible delay means "contains our clip". Could even subtract it
(adaptive filter) to keep his words in an overlap.

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| accuracy   | very high for those clips, independent of STT and language                            |
| latency    | 10–50 ms per utterance (a fetch is cached)                                            |
| cost       | ~10 agent hours; one more network fetch per sentence                                  |
| fails when | `speechSynthesis` (no bytes), streams, rate changes (`playbackRate`), Bluetooth delay |

Recommend **not now**: (b) + (c) should cover the incident; revisit if M5
shows echoes left that only this would catch.

## The verdict, in one place

The chat hub decides, per voice line of his, before `merge`/`twoMic`/`post`:

| evidence                                                                                 | verdict                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| speaker `self` (signed)                                                                  | echo, kind `self-voice`                                                          |
| time overlap + text ≥ 0.6 (b), unless a strong signed `me` and the voice was not `clone` | echo, kind `read-aloud`                                                          |
| no report, agent line ≤ 60 s + text ≥ 0.8 (today's rule)                                 | echo, kind `read-aloud`                                                          |
| his line from another device (today's rule)                                              | echo, kind `other-device` (hidden, as now: it is a duplicate, not foreign words) |
| anything else                                                                            | his line, as today                                                               |

Logged `debug.echo` as today, plus `layer` (`report`, `landed`, `self`),
`sim`, `overlapMs`, `voice`. Never the text.

## UI: collapsed, labelled, expandable

- A `read-aloud` or `self-voice` echo **is shown**, as one slim row where the
  line would have been: speaker icon, the label "Read aloud, heard back"
  (localised, with a context line, [i18n.md](i18n.md)), and the first words
  dimmed. A tap expands it: the full text, which line it echoed (a link that
  scrolls there), the layer and score for a `dev` holder.
- **"This was me"** in the expanded row posts it as his line (`restoreEcho`,
  existing `unmerge` path). Only then does it reach lanes and Li.
- An `other-device` echo stays hidden (it is his own words twice).
- **Never routed**: an echo is not written to the thread's line list at all,
  so nothing that reads lines can pick it up by mistake. It travels in its
  own frame `{type:"echo", line}` to his pages only, and in the state
  snapshot as `echoes` (the kept `echo:<id>` entries). So: not in
  `listeners()`, not in `tokens.chat`, not in `ownerAi.line`, not in
  `autoPolishSoon`, not in merge/twoMic, never read aloud, not in D1 chat
  history (`chatLogLine` is never called for it).
- Many in a row fold into one row: "3 read-aloud echoes".

### Config keys (lib/config.ts, `cfg()`)

| key                                                      | default        | what                                                                 |
| -------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| `voice.echoPlaySimilarity`                               | 0.6            | text line when a play report overlaps in time                        |
| `voice.echoSlackMs`                                      | 1500           | slack each side of a play report                                     |
| `voice.echoPlayKeepMs`                                   | 120000         | how long the chat hub keeps play reports in memory                   |
| `voice.echoSimilarity`                                   | 0.8 (exists)   | the no-report fallback line                                          |
| `voice.echoReadWindowMs`                                 | 60000 (exists) | the no-report fallback window                                        |
| `voice.echoShowMax`                                      | 50             | echoes kept for the collapsed rows (today's `ECHO_KEEP`)             |
| `voice.cloudWhileMic`                                    | `android`      | prefer cloud TTS while the mic is open: `never`, `android`, `always` |
| `stt.selfAccept` / `stt.selfMargin` / `stt.selfMeMargin` | set in M4      | the self decision lines (also env on the Mac, like `ME_MARGIN`)      |

### Flags (lib/flags.ts, positive names, default **on**, audience owner)

- **`voice.echo-reports`** — pages report what they play and the chat hub
  matches by time and text; echoes are shown collapsed. Off = today's
  behaviour exactly (landed-time match, hidden). His emergency off switch:
  <https://lianki.com/dev/flags#voice.echo-reports>.
- **`stt.self-voice`** — the Mac tags our own TTS voices as `self`. Off =
  no `self` decision, the print files are ignored. Sent to the Mac like the
  filter (`{t:"selfVoice", on}`), off until said.
- `voice.echo-dedupe` stays the switch for the whole echo step.

## Data and privacy

- **No audio is stored, sent or kept for this.** Layer (b) is text and
  times; (c) reads embeddings of our own generated voices, never a person.
  The enrolment clips are generated, embedded and deleted in a temp dir.
- **Play reports live in the chat hub's memory**, 120 s, his thread only.
  /reader texts can be private (`[data-lk-private-screen]`): a report from a
  private screen sends only a hash of each n-gram set, matched the same way
  (no readable text leaves the page). Recommend this for every report if the
  cost is acceptable.
- **Logs**: `debug.echo` gets ids, layer, score, gap, overlap, voice id;
  `head(text)` (today's 20-character head) is dropped for `self`/`report`
  echoes, numbers only. The Mac logs `spk self 0.71` like every final.
- **Echo lines are not in the account's history** (chat-history.md, "Never
  kept" gains "echoes"); they stay in the chat hub's `echo:<id>` store, the
  newest 50, until "This was me" or eviction.
- /privacy needs no change: no new audio, no new kind of stored data.

## Milestones

|     | what                                                                                                                 | agent hours |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| M0  | read `debug.echo` / `voice-utt` / `voice-out` logs around 14:2x JST; confirm which hole                              | 0.5         |
| M1  | layer (a): containment + time window in the page guard; /words passes text; `voice.cloudWhileMic`                    | 2           |
| M2  | layer (b): `playing`/`played` frames, hub-clock spans, in-memory store, matcher, verdict table, `voice.echo-reports` | 6           |
| M3  | UI: `echo` frame and `echoes` snapshot, collapsed rows, "This was me", i18n with context, tests in happy-dom         | 4           |
| M4  | layer (c): self-print script, `self` decision, signed tag, wire type, eval with simulated channel, set thresholds    | 5           |
| M5  | a day on his devices with both flags on; tune lines from the counts in the Voiceprint panel                          | 1 + his day |
| M6  | (optional) layer (d) on the Mac                                                                                      | 10          |

M1–M3 fix the incident class; about 12 agent hours. M4 adds the acoustic
backstop for lines whose text STT mangles.

## Open questions (with the default I would take)

1. **Show or hide `read-aloud` echoes from today's rule?** Default: **show
   collapsed**, as he asked; only `other-device` stays hidden.
2. **Does a strong `me` override a text match?** Default: **yes**, except
   when the playing voice was `clone`.
3. **Similarity with a time overlap?** Default **0.6** containment (the
   talk-over value already used on the page), tuned in M5.
4. **Hash the reported text?** Default: hash for private screens only, plain
   text in memory otherwise (needed for the spoken/written comparison and
   simpler to debug).
5. **Which voices get a self print first?** Default: the cloud voices we
   actually use (MeloTTS, Aura, `voice.langVoices`); device voices only if
   M4 shows `say -o` renders of the macOS twins score close to the phone's.
6. **Cloud TTS while the mic is open on Android?** Default **`android`**:
   AEC handles our `<audio>` better than Android's `speechSynthesis`, at the
   cost of credits.
7. **Keep `self` lines in history?** Default **no**: they are our words, not
   his.
8. **Do lanes get a count of echoes?** Default: **no** text; `lianki-dev
   doctor` shows today's echo count by layer, for tuning.
