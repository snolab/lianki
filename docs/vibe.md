# /vibe: a conversation becomes a private doc

The owner asked for this on 2026-11-06: he talks with a foreigner, each learning
the other's language; the conversation is heard live, transcribed into a private
doc read in /read, and the words heard are offered as a 新词 list. His card
answers: keep all speakers' text (no voice filter); the text is stored in the
account (D1), readable in /read on any device.

**Dark.** Flag [`read.vibe`](https://lianki.com/dev/flags#read.vibe), default
off. **Off means nobody can start it, the owner included**: unlike every other
flag, there is no owner bypass. On, it is still the owner only: the voice front
end is owner-only ([local-stt.md](local-stt.md)). Page, routes and the Preferences
row all answer 404 otherwise (`lib/vibe/gate.ts`, `lib/vibe/route.ts`). Documents
already written stay readable and deletable with the flag off.

```
consent screen ─ tap ─▶ POST /api/vibe {consent:true} ─ 404 flag off: no mic, nothing
                        │
phone mic ─ Silero VAD ─ frames ─▶ wss://<mac>.ts.net/lianki-stt  (tailnet only, audio ends here)
                        ◀─ partial, final text ─  SenseVoice on the Mac
                        │
createMic: cleanTranscript, judgeFinal (the silence guard)
                        │ text only
POST /api/vibe/<id>/lines ─▶ a read_materials row (source "vibe"), each line's language detected
                        └ tellReaders ─▶ /read/<id>?streamingFrom=vibe on any device
```

## What is reused

Nothing here is a second pipeline.

| Piece | Where | Used as |
| --- | --- | --- |
| The mic core: VAD handling, utterances, endpoint, `cleanTranscript`, **`judgeFinal`** | `packages/debug-chat/src/mic.ts` `createMic` | as is, with no chat, wake word, enrolment, cue or estimator attached |
| Stream and VAD in the browser | `MicButton.tsx`, new `voiceCapture()` | `micStream`, `silero`, `energy`, untouched |
| The Mac client | `local-stt.ts` `createLocalStt`, `localSttRoute` | no `device`, `thread` or `filter`: every speaker kept |
| Per-line language | `lib/read/lang-detect.ts` `detectLangs`, `toRuns` | stored as `BookMeta.langs`, shown per line |
| The reader, live | `reader-stream.tsx` `useBookStream`, ReaderV2, lianki-push `read-stream` | `?streamingFrom=vibe`; finals only, and `LiveTail` is not mounted, since its card would translate the newest line by itself |
| Material storage, privacy, delete | `lib/getReadMaterialsCollection.ts`, `DELETE /api/read/[id]`, the /read row menu | as is; cards carried by `carrySentenceCards` as a re-import does |
| Daily trigger | `worker.ts` `scheduled` (the ledger's cron) | retention sweep beside the anchor |

## Audio

**Audio stays on the owner's Mac.** Not stored, not uploaded, and no route here
takes any.

- **Tailnet only.** `vibeRoute` drops `TICKET_HOSTS`: the tunnel's TLS ends at
  Cloudflare's edge, which sees audio in clear ([local-stt.md](local-stt.md),
  "Trade-offs"). With the tailnet down, /vibe says so and does not start.
- **No cloud fallback.** The chat's mic falls back to `/api/debug/stt` when the
  Mac fails. This `upload` never does: a final that fails is dropped and counted
  on screen.
- **No clips.** The clip sink is `cfg.clipSink` in `MicButton`'s upload, which
  this path does not use. `server.py` writes no audio outside enrolment, which
  takes a passkey ticket. `~/lianki-voice-clips` gets nothing.
- **No sounds.** No `cue` is passed to `createMic`.
- The estimator (`adaptive.ts`) learns the owner's voice; it is not fed from here.

## Consent

Every start goes through one full screen (`VibeClient.tsx`): the statement in the
language picked for the other person, plus the user's own; Start, Cancel. Cancel
is a link back to /read that opens nothing.

- Text: `vibe-consent.content.ts`, all 16 locales, each key with its context line.
  The page's server component reads it once per locale.
- It says: this conversation is being transcribed; the sound is not recorded or
  uploaded; the text is stored in my Lianki account, on Cloudflare; only I can see
  it unless I share it; when it is deleted (the user's own number); and you can
  say no.
- **Start is the only way in.** It ignores untrusted clicks (as the voiceprint
  panel does). `POST /api/vibe` needs `consent: true` exactly, and is asked
  *before* the Mac and the microphone: a refusal opens nothing. Nothing starts on
  load, from a URL or from a command. `vibe_doc.consent_ms` and `other_lang` record it.
- Resume after a pause is the same conversation, so it does not ask again. A new
  conversation, a reload, or leaving the page does.

## While it runs

An indicator stays on screen (`Indicator`): a red dot and "Transcribing", Pause,
Stop. No sounds.

**Pause** (`lib/vibe/session.ts`): tracks stopped, the utterance under way
cancelled on the Mac, socket closed, all at once. Finals that land later belong
to an old `run` and are dropped. The server refuses lines unless the doc is
`running` (409), so a late write cannot get through either way. Lines heard
*before* the pause are still sent. Resume is a new `getUserMedia`, by tap only.

It pauses itself, saying why:

| event | pause |
| --- | --- |
| page hidden, `pagehide` | `hidden` |
| `offline` | `offline` |
| Mac socket `down` | `stt` |
| a track ended (a call, unplugged) | `mic` |
| a line could not be saved (network, 429, 5xx) | `server`: lines are kept in memory and sent on resume |

A 404 on a line (the flag turned off, the doc deleted) ends the conversation; the
flag's cache means within 30 s. Leaving the page ends it too.

**Live reading on the same phone** ends up pausing, because opening /read hides
/vibe. Another device follows it at `/read/<id>?streamingFrom=vibe`.

## Nothing said is a command

`createMic`'s `onText` goes to `lines` and nowhere else. The chat's taps
(`mic-taps.ts`), the session (`mic-session.ts`) and `voiceTap` are not on this path.

The chat's own mic would hear the same room, so while /vibe runs:

- `micTaps().block()` turns the chat's mic off, refuses its taps and its reload
  resume (`MIC_BLOCKED_NOTE`), and has `offer` swallow anything still arriving.
- A `BroadcastChannel` turns off the chat's mic in this browser's other tabs.
- `[data-lk-private-screen]` stops `screenText` (`scene.ts`) from sending the
  transcript as a voice line's context. Both /vibe and a transcript in the reader
  carry it.

Not covered: a chat mic on another device or another browser in the same room,
and a deliberate tap on the chat mic in a tab opened after the start.

## The doc

A `read_materials` row with `source_key` `vibe:<id>`, `BookMeta.source` `"vibe"`.
It appears in /read like any other; `/api/read/[id]` and every reader route ask
for the signed-in user's own row, and a deep link by hash resolves only to the
reader's own copy. There is no public or shared path.

`vibe_doc` (migration 0052) holds what makes it a transcript: status, consent,
`next_seq`, `last_ms`. Its `material_id` stays NULL until the first line, so a
start with nothing said leaves nothing in /read, and stop deletes the row.

- `next_seq` makes a retry harmless: a batch overlapping what is held adds only
  what is new; a gap is 409. Text is written before the count, so a failure
  between them repeats a line rather than losing one.
- Size: `BOOK_LIMITS` (1.5 MB of text); then 413, and the screen says so.
- **Speakers: not labelled.** SenseVoice has no diarisation. The transcript shows
  each line's language and nothing about who said it.
- **Languages.** SenseVoice knows zh, yue, en, ja, ko. Other languages come out
  wrong; the consent screen tells the user.

### No polish

`NEVER_OFFERED` in `lib/read/polish-offer.ts` holds `"vibe"`: no offer, no action
in the contents sheet, however the doc is opened. `shape.raw` is stored false, and
`POST /api/read/[id]/polish` and `polish-live` refuse it (`polishRefused`). The
doc is private speech; the tidy would send it to a model.

Selecting text in the reader can still translate it through the metered route,
as in any book: that is his tap, on that text.

## 新词

The New words tab on /vibe (`VibeWords.tsx`, `lib/vibe/new-words.ts`) lists the
words heard: no card first, then due, learning, known, each by how often it was
heard. Each carries the reader's own mark (`.lk-book [data-f]`, `famMap`) and its
language (the line it was first heard in). There is no speaker: see above.

A tap opens a card built on `NewWordStrip`, the reader's shared preview. **Nothing
is created without a swipe:**

- The list reads `GET /api/read/<id>/words` and a `batch-grade` probe, when a new
  line is saved. Nothing polls.
- The card's meaning is `fetchCachedGloss`, so `cached: true`: decks and
  shared glosses, no model, no credits. The user's own AI key is not used here
  either, since that would send the sentence somewhere before a swipe. Elsewhere a
  tap does ask the model (books-plan.md, "Grading from the selection card"); here it
  never does, and the gloss route enforces that for a doc of this kind
  (`glossMayAskModel`).
- Only the slider's grade calls `commit`, held `GRADE_HOLD_MS` as a reader grade
  is. Undo in the hold sends nothing. Then one `batch-grade` makes the card in the
  book's own deck and grades it; the AI meaning and its charge happen there. Undo
  after that takes both back.
- A word that already has a card shows its mark and "Already in your deck". Due
  words are reviewed in /words or the reader, not here.

On another device, tapping a word in `/read/<id>` opens the same preview, with the
same rule for its meaning. With the user's own AI on, its slider asks no model of
ours either, so a word nothing has a meaning for is carded without one.

## Retention

30 days by default, from a doc's **newest line**. `/preferences` has the number
(`VibeRetention.tsx`, 1–3650, `vibe_settings`). It applies to every doc of that
user at once, since the sweep reads it at run time.

The sweep is `sweepVibeDocs` (`lib/vibe/retention.ts`), in the Worker's existing
daily Cron Trigger next to the study ledger's anchor. No new trigger, no polling.
A failure in one job does not stop the other, and either still fails the run. It
takes the material, its R2 content and its reader rows. A word card the user made
from the doc stays in their deck: it is theirs.

Delete at any time: the /read row menu, or the button on /vibe's end screen.
`vibe_doc` goes with the material (`ON DELETE CASCADE`).

## Code

| piece | where |
| --- | --- |
| flag and gate | `lib/flags.ts`, `lib/vibe/gate.ts` |
| routes | `app/api/vibe/{route,[id]/lines,[id]/state,settings}`, answers in `lib/vibe/api.ts`, gate in `lib/vibe/route.ts` |
| writes | `lib/vibe/store.ts` |
| sweep | `lib/vibe/retention.ts`, `worker.ts` |
| session | `lib/vibe/session.ts` (pure), `lib/vibe/browser.ts` (the browser's half) |
| page | `app/(app)/vibe/` |
| 新词 | `app/(app)/vibe/VibeWords.tsx`, `lib/vibe/new-words.ts` |
| tests | `unit/vibe.test.ts`, `unit/vibe-words.test.ts`; `scripts/qa/qa-vibe.mjs` (fake mic, stub VAD, a stand-in Mac, invented text; no real microphone, no sound) |
