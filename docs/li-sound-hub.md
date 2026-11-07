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
| mic      | `pageAudio().listen` (`page-audio.ts`): /read's shadowing, fed by the chat mic              |
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
is counted until the next change; /read's shadowing listener (it uses the
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
