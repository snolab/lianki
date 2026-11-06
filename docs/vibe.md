# /vibe: a conversation diary

The owner asked for this on 2026-11-06: he talks with a foreigner, each learning
the other's language; what's said becomes private text he reads back in /read,
and the words heard are offered as a 新词 list. All speakers' text is kept (no
voice filter), in his account (D1), readable on any device.

**It is his personal memory, like a diary**: "not a legal contract and not for
sharing" (owner, 18:23 JST 2026-11-06). So no form to get through, nothing to
share, nothing deleted unless he asked. The wording stays plain and warm.

**Dark.** Flag [`read.vibe`](https://lianki.com/dev/flags#read.vibe), default
off. **Off means nobody can start it, the owner included**: unlike every other
flag, there is no owner bypass. On, it is still the owner only: the voice front
end is owner-only ([local-stt.md](local-stt.md)). Page, routes and the Preferences
row all answer 404 otherwise (`lib/vibe/gate.ts`, `lib/vibe/route.ts`). Documents
already written stay readable and deletable with the flag off.

```
start page ─ tap ─▶ POST /api/vibe {tap:true} ─ 404 flag off: no mic, nothing
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
| Daily trigger | `worker.ts` `scheduled` (the ledger's cron) | the optional delete-after-N-days sweep, beside the anchor |

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

## Pages

Three addresses, one gate (`lib/vibe/page-gate.ts`): 404 unless `read.vibe` is on
and this is the owner.

| address | what |
| --- | --- |
| `/vibe` | the list, newest first (`VibeList.tsx`, `listDocs`): title, date, languages, length, last update; ⋯ Rename and Delete |
| `/vibe/new` | where Start lives (`VibeClient.tsx`) |
| `/vibe/<id>` | one conversation's log (`getDocLog`): its lines, languages and 新词, with Keep going |

- `<id>` is `vibe_doc.id`, `crypto.randomUUID()`: random, not a count. Someone
  else's id, or none, is 404, as for a doc that does not exist.
- **The address follows the first line.** `/vibe/new` becomes `/vibe/<id>` by
  `history.replaceState` once a line is saved, without leaving the page, so a stop
  that heard nothing leaves no entry and no address. The list reads through a join
  on the material, so a start that heard nothing (material NULL) is not on it.
- **Delete** asks once by the browser's confirm, as a /read row does. A material's
  delete takes its row and its R2 content at once, so there is no undo to offer.
- **Rename** is the material's (`PATCH /api/read/<id>`); `title_custom` keeps it
  through later lines.
- A `/vibe?doc=<id>` or `?id=<id>` link redirects to `/vibe/<id>`. No such link was
  ever written; the redirect is there for any by hand.
- **Live.** On the recording page the view is the session itself. Any other device
  on `/vibe/<id>` while the doc is not stopped follows it through the reader's
  stream (`useBookStream`).
- **Keep going** is a tap on the log, by the same rules as Start: trusted click,
  server first (`state: running`), then the Mac and the mic. It reopens a stopped
  conversation, since leaving the page stops it and that is how one comes back. Only
  that tap reopens: a late "paused" gets 409. One writer at a time: it closes any
  other open conversation, whose page then ends. Opening a log never opens a mic.

## Starting

`/vibe/new` is a simple page (`StartPage` in `VibeClient.tsx`): the title, one line
on what happens, Start, one line to the user, and the recognised languages. No
form, no dialog, no language picker, nothing to accept.

**The line to the user** (`yourCare`): this page turns what's said nearby into
text, and it's up to you to make sure the people around you are happy with that.
It is addressed to the user and nobody else (owner: "that user has their own
responsibilities to make everyone happy"). It is plain text beside Start: no
dismissal, no tap, no delay.

- **Start is the only way in.** It ignores untrusted clicks (as the voiceprint
  panel does). `POST /api/vibe` needs `tap: true` exactly, and is asked *before*
  the Mac and the microphone: a refusal opens nothing. Nothing starts on load,
  from a URL or from a command.
- Resume after a pause is by tap too. A reload or leaving the page ends the
  run; the next is a tap on Start or on Keep going.
- `vibe_doc.other_lang` and `consent_ms` are 0052's columns, read by nothing now:
  `''` and the time of the tap are written.

## While it runs

A small indicator stays on screen (`Indicator`): a red dot and "Transcribing",
Pause, Stop, each one tap. No sounds.

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
reader's own copy. There is no public or shared path, and nothing on the page
offers one: the reader's selection card has no Copy link on these docs
(`copyLink` is left out for source `vibe`).

`vibe_doc` (migration 0052) holds what makes it a transcript: status, `next_seq`,
`last_ms`. Its `material_id` stays NULL until the first line, so a
start with nothing said leaves nothing in /read, and stop deletes the row.

- `next_seq` makes a retry harmless: a batch overlapping what is held adds only
  what is new; a gap is 409. Text is written before the count, so a failure
  between them repeats a line rather than losing one.
- Size: `BOOK_LIMITS` (1.5 MB of text); then 413, and the screen says so.
- **Speakers: not labelled.** SenseVoice has no diarisation. The transcript shows
  each line's language and nothing about who said it.
- **Languages.** SenseVoice knows zh, yue, en, ja, ko. Other languages come out
  wrong; one short line on the start page says so.

### Translations

Owner, 18:31 JST 2026-11-06: "automatically recognize every word and translate
sentence to each others languages", "as a new column". **His explicit choice to send
lines to a model**, which changes the earlier rule of no text to a model on /vibe.
It is narrow: finished lines, translation only. The start page says so in one line
(`sentToModel`). Polish stays refused, below.

- **Which languages** (`lib/vibe/translations.ts`, `conversationLangs`): any language
  making up more than the setting's share of the lines so far with a detected
  language. No fixed pair and no per-language code. The share is
  `vibe.translateMinPct` (`lk:vibe-translate-min-pct`, /preferences), 20 by default:
  the owner's number. Exactly 20% does not count.
- **Which lines**: each into those languages but its own. A language that reaches
  its share later brings the earlier lines along, newest first, two at a time.
- **The path**: `POST /api/vibe/<id>/translate`, `translateLine`, which is the reader's
  `translate()` (model, limiter `AI_LIMIT_LIVE`, `chargeAi` as `vibe.translate`, which only logs the cost today: the user is not charged credits).
  Refused unless the text is one of the doc's lines. With the user's own AI on, the
  browser calls their provider (`translateOwn`), and the answer stays in the tab, as
  in the reader (docs/byok.md).
- **Private**: not in the shared `read_translation`. `vibe_translation` (0055) holds
  one row per doc, language and line; it goes with the doc (`ON DELETE CASCADE`, through
  `vibe_doc`). That row is the cache: a line is never charged twice.
- **When**: a paused conversation sends nothing, on the page (`canRun`) and on the
  server (409). Opening a log sends nothing and costs nothing: it shows what its rows
  hold. A stop lets the page finish the lines it heard. A line a stop or an older doc
  left out stays blank until Keep going brings it along.
- **A failure** shows that line with a calm "not translated" and touches nothing else.
  It is not asked again by itself, so nothing can spend in a loop.
- **Layout**: a second column from `sm` up; stacked under each line on a phone.

Every word on either column carries the reader's mark and opens the same card as the
新词 list: a preview (`fetchGloss` cached, no model), a slider, nothing created
without a swipe. A line's words have the full marks (`famMap`). A translation's words
are not the doc's counted words, so they have only what the probe tells: a card or
none (`data-f` `l2` or `u`), without the reader's learning bands.

### No polish

`NEVER_OFFERED` in `lib/read/polish-offer.ts` holds `"vibe"`: no offer, no action
in the contents sheet, however the doc is opened. `shape.raw` is stored false, and
`POST /api/read/[id]/polish` and `polish-live` refuse it (`polishRefused`). Sending
lines to a model is for translation only.

Selecting text in the reader can still translate it through the metered route,
as in any book: that is his tap, on that text.

## 新词

The New words tab on a conversation (`VibeWords.tsx`, `lib/vibe/new-words.ts`) lists the
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

## Keeping

**Kept until deleted.** Nothing is deleted by itself unless the user set a number.

`/preferences` has that number (`VibeRetention.tsx`, 1–3650), empty and "Off" by
default. It counts from a doc's **newest line** and applies to every doc of that
user at once, since the sweep reads it at run time. Clearing the field turns it
off again. The field saves only what the user changed.

`vibe_settings.chosen` is what makes a number count. The sweep joins on
`chosen = 1`, so a user with none is never looked at.

**A row from before this (0052, #647).** That field started at the old default of
30 and saved on blur, so tapping in and out wrote a 30 nobody chose. No other path
wrote a row: a start never did. Migration 0053 adds `chosen`, 0 by default, and
sets 1 only where the number is not 30, since any other number could only have
been typed. So an old 30 reads as off, whoever typed it; choosing 30 afterwards
counts. Nothing is deleted in the transition. Should the column be missing, the
sweep fails and deletes nothing.

The sweep is `sweepVibeDocs` (`lib/vibe/retention.ts`), in the Worker's existing
daily Cron Trigger next to the study ledger's anchor. No new trigger, no polling.
A failure in one job does not stop the other, and either still fails the run. It
takes the material, its R2 content and its reader rows. A word card the user made
from the doc stays in their deck: it is theirs.

Delete at any time: /vibe's ⋯ menu, the /read row menu, or the button on the log.
`vibe_doc` goes with the material (`ON DELETE CASCADE`). A start that heard nothing
and was never stopped (the tab closed) leaves a `vibe_doc` row with no text and
nothing in /read; for a user with no number it simply stays.

## Code

| piece | where |
| --- | --- |
| flag and gate | `lib/flags.ts`, `lib/vibe/gate.ts` |
| routes | `app/api/vibe/{route,[id]/lines,[id]/state,settings}`, answers in `lib/vibe/api.ts`, gate in `lib/vibe/route.ts` |
| writes | `lib/vibe/store.ts` |
| sweep | `lib/vibe/retention.ts`, `worker.ts` |
| translations | `lib/vibe/translations.ts` (pure), `lib/vibe/translate-server.ts`, `app/api/vibe/[id]/translate` |
| session | `lib/vibe/session.ts` (pure), `lib/vibe/browser.ts` (the browser's half) |
| pages | `app/(app)/vibe/`, `lib/vibe/page-gate.ts` |
| 新词 | `app/(app)/vibe/VibeWords.tsx`, `lib/vibe/new-words.ts` |
| tests | `unit/vibe.test.ts`, `unit/vibe-words.test.ts`, `unit/vibe-translate.test.ts`; `scripts/qa/qa-vibe.mjs` (fake mic, stub VAD, a stand-in Mac, invented text; no real microphone, no sound) |
