# Voice mode: spoken commands on the current screen

The owner asked for this on 2026-11-02 at 20:06 JST, in the in-app chat:
"/words 单词列表要一个纯语音模式 — 用口令操作：上下左右、上一张/下一张，复习操作（评分等）也做成口令".
While voice mode is on, short spoken commands move through the list and grade
it. No wake word is needed.

**The chat comes first** (the owner, 2026-11-03 03:12–03:14 JST:
"语音口令模式不应该影响我跟你发送指令", "打开语音口令模式后，形式仍以聊天为主",
"还能操作我当前所在的画面", "当口令严格匹配的时候，也可以跳过触发你的"). A line
that strictly matches a command of the screen he is on runs there, is
confirmed on the badge, and is kept from the chat, so it wakes no agent turn.
Every other final transcript goes to the chat as a normal message, exactly
as with the mode off. Before this (#421 as merged) voice mode kept every
line from the chat but "Linky, …", so he could not talk to the agent while
it was on.

## Turning it on

| Who            | How                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- |
| Everyone       | flag `words.voice-mode` on at `/dev/flags`, then /words → Settings → Experimental → **Voice commands** |
| The owner      | the same switch, shown with a "preview" tag while the flag is still off                     |

- The switch is the synced pref `words.voiceMode` (`lk:words-voice-mode`,
  [prefs-sync.md](prefs-sync.md)). The mic is still asked for on each device.
- The server decides who sees the switch (`lib/words/voice-access.ts`,
  called in `app/(app)/words/page.tsx`): `on` when the flag is on, `preview`
  for the owner while it is off, otherwise `off`. With `off` the pref does
  nothing.
- A glass badge over the bottom of the list says "Voice commands on" and what
  to say. When the mic fails it says so, and a tap on the badge tries again
  (some browsers need a tap before they start the mic).

## Commands

The table is `GRAMMAR` in `lib/words/voice-commands.ts`. Chinese comes
first, with English and Japanese synonyms. Simplified and Traditional both
match.

| Command  | zh                                      | en                     | ja                 | What it does (the same path as)                       |
| -------- | --------------------------------------- | ---------------------- | ------------------ | ----------------------------------------------------- |
| next     | 下一张 / 下一个 / 下 / 向下 / 下面      | next, down             | 次 / 次へ / した   | focus (touch) or cursor (desktop) one row down        |
| prev     | 上一张 / 上一个 / 上 / 向上 / 上面      | previous, back, up     | 前 / 前へ / うえ   | one row up                                            |
| left     | 左 / 向左 / 左滑                        | left                   | ひだり             | a one-level ← swipe: **Hard** (mirrored: **Good**)    |
| right    | 右 / 向右 / 右滑                        | right                  | みぎ               | a one-level → swipe: **Good** (mirrored: **Hard**)    |
| again    | 重来 / 忘了 / 不记得 / 不认识           | again                  | もう一度 / 忘れた  | grade Again                                           |
| hard     | 困难 / 难 / 很难 / 模糊                 | hard                   | 難しい             | grade Hard                                            |
| good     | 良好 / 记得 / 认识 / 记住了             | good                   | 正解 / 覚えた      | grade Good                                            |
| easy     | 简单 / 容易 / 太简单                    | easy                   | 簡単               | grade Easy                                            |
| show     | 显示答案 / 答案 / 看答案 / 翻面         | show answer, reveal    | 答え / 答えを表示  | reveal the current card                               |
| read     | 再读一遍 / 再读 / 重读 / 再说一遍 / 重复 | read again, repeat     | もう一回 / 読んで  | read the current card aloud again (as a tap does)     |
| undo     | 撤销 / 撤回 / 回退                      | undo                   | 元に戻す / 取り消し | Z: undo the last grade                                |
| exit     | 退出语音模式 / 关闭语音模式             | exit voice mode        | 音声モード終了     | turn voice mode off                                   |

左/右 follow the side as the screen shows it: with Settings → **Mirror swipe
sides** on (`words.swipeMirror`, [swipe-core.md](swipe-core.md)), 左 grades
Good and 右 Hard, and the confirmation reads `← Good`. The named grades
(重来, 困难, 良好, 简单) never move. /review has no swipe and keeps 左 = Hard.


A grade moves on to the next card the way a swipe (touch) or a key (desktop)
does: only when the card had no grade yet. The study view hands the voice
mode `VoiceActions` built from its own functions (`swipeGrade`, `keyGrade`,
`undo`, the focus, `speech.once`). `lib/words/voice-dispatch.ts` maps each
command to one of them and does nothing else. The /words read-aloud keeps
working as before: a new focus reads its word.

## Matching: whole utterances, no guesses

- **Whole utterance only.** The normalized transcript must be a command
  phrase. Normalizing applies NFKC, lowercase, Simplified Chinese, and drops
  punctuation, spaces, SenseVoice `<|tags|>` and padding such as 嗯/请/吧,
  "okay", "please" and ください. Anything longer than 16 characters is a
  sentence. "我觉得下一张更难" and "把左边那个改一下" do nothing. A
  demonstrative is not padding: "那个左边" ("that left one") and "あの右"
  stay sentences, never 左边/右.
- **Grades exactly as said.** Again/Hard/Good/Easy and 左/右 take no slip at
  all: 有点累 is not 有点难, 很简短 is not 很简单. Only moving, the answer,
  reading, undo and exit forgive a slip.
- **Fuzzy only where it is safe.** A slip may change or lose a character,
  never add one. One is forgiven on CJK phrases of 3+ characters
  (再读一边 → 再读一遍, 显示答 → 显示答案) and on Latin phrases of 7+ letters
  (previus); two from 10 letters. Shorter phrases must match exactly, so
  "night" is not "right". An added word is a different sentence: "no show
  answer", 未记住了, 下一张吗 match nothing. A slip may never add or drop a
  negation (不/没/未/无, not/no/never, ない): 我记得 is not 不记得. A slip
  equally close to two commands (啥一张) matches nothing.
- **No questions.** A "?" or a closing 吗/么/呢/か is never a command
  (简单吗, 簡単ですか).
- **Not a card's own words.** The utterance is no command when it equals
  (within a slip) the word, reading, meaning, example or a read-aloud part of
  any card near the focus. It is also no command when it is merely
  contained in what the focused card, or the one before it, reads aloud
  (`sayParts`), within a slip: a run of whole words for Latin ("go down" in
  "go down the street"), anywhere for CJK (下一章 in 请看下一张图片). So "easy" read from
  "easy (not difficult)" never grades Easy, an English list's "good" never
  grades Good, and a Japanese 上 never moves the cursor. The cost: a grade
  word inside the focused card's meaning (简单 in 简单的) is not taken for
  that card; a synonym (容易, 右) still is. Exit is the one command never
  blocked.
- **Only a strict command is kept from the chat.** The tap (`voiceTap` in
  `lib/words/voice-dispatch.ts`) returns true for a command of this screen
  that ran, or that the badge explains (a card's own word, no card yet).
  A sentence, a question, "Linky, …", or a command this screen did not
  register runs nothing, shows no flash, and goes to the chat. The routing table, with
  Chinese, Japanese and English lines, is in `unit/voice-commands.test.ts`
  ("voice mode never stands between him and the chat").

## Screens: each registers its own commands

The mic, the chat and the switch are global; what a command does belongs to
the screen he is on. A screen registers the `VoiceActions` it has, as a
`Partial<VoiceActions>`. A command it leaves out does nothing (the line still
goes to the chat), and a screen that registers nothing gets nothing: its
lines are the chat's.

| Screen    | Registers                                              |
| --------- | ------------------------------------------------------ |
| `/words`  | all: move, grade (and ←/→), show, read, undo, exit     |
| `/review` | grade (Again/Hard/Good/Easy, ← Hard, → Good) and exit |

A spoken grade on /review opens no placeholder tab for the next card: a
voice line is no user gesture, so the browser would block it.

To add a screen:

1. In its `page.tsx`, pass `voiceAccess(await readFlags(), isOwner(email))`
   (`lib/words/voice-access.ts`) to the client.
2. In the client:

   ```tsx
   const [voicePref, setVoicePref] = useVoicePref(); // app/(app)/words/VoiceMode.tsx
   const vtext = useIntlayer("words-voice-mode");
   const voiceMode = useVoiceMode(voice !== "off" && voicePref, (heard) =>
     handleUtterance(heard, {
       actions: { grade: (r) => void grade(r), exit: () => setVoicePref(false) },
       cardTexts: [/* the screen's own words, for the echo check */],
       hasCard: !!current,
     }),
   );
   // …
   <VoiceBadge state={voiceMode.state} flash={voiceMode.flash} retry={voiceMode.retry}
     label={(o) => voiceOutcomeLabel(o, vtext, gradeNames)} bottom={0} hint={null} />
   ```

3. Add the screen to the table above, and its actions to
   `unit/voice-commands.test.ts`.

The actions must be the screen's own paths (the same as its keys or
buttons), never new ones, and never anything that deletes or touches the
account (see "Safety").

## Feedback

After each command a short glass line shows above the badge for 1.8 s. This
is the only place a command shows: it does not appear in the chat log.
Anything else shows nothing here (the chat shows it). It is a live region:

- a command: ✓ and its name ("↓ 下一张", "→ 良好", "已撤销上一次评分");
- a card's own word: 听到「…」：这是卡片上的词，没有执行;
- a grade with no card loaded yet: 还没有可操作的卡片.

The strings are the `words-voice-mode` dictionary
(`app/(app)/words/voice-mode.content.ts`), 16 locales, each with its
context line.

## Push to talk

Owner, 2026-11-10 ("长按说话", "lose not a single second"), on the chat's mic
(`packages/debug-chat/src/ptt.ts`, wired in DebugChat's mic gesture and
MicButton's `pttRecorder`):

- **A tap** toggles always-on listening, the VAD as ever.
- **A long press** (`PTT_HOLD_MS`, the platform's long-press) is ONE voice
  line. Recording starts at the pointerdown itself, which is the line's
  `t_speechStart`. While held, no VAD or endpoint cuts it (the always-on
  capture holds: `setPttHolding`), so soft or whispered speech is kept whole.
  The held state is a pulsing seal-red ring with the seconds held, plus a
  light haptic where `navigator.vibrate` exists.
- **Release** keeps `PTT_TAIL_MS` (1 s) more, then sends the clip through
  the same STT route once and **sends the line** (source `stt`, no draft). A
  clip past the route's size limit (`PTT_MAX_WAV_BYTES` = `STT_MAX_BYTES`) is
  sent in pieces, transcribed in order, and still makes one line.
- **Pre-roll**: while the always-on mic is open, its last `PTT_PREROLL_MS`
  (2 s) sit in a ring in memory (`createRing`) and go in front of the clip.
  The ring is never stored or uploaded unless that clip is sent.
- **Cancel**: held, sliding `PTT_CANCEL_PX` away arms a cancel (the ring
  dashes, "✕"); letting go there drops the clip, and coming back disarms it.
- **History**: it replaces the old drag-the-mic-to-scroll-history gesture.
  Drag the history itself (log-engage.ts); ↑/↓ on the focused mic still steps
  back. A sideways drag before the hold still moves the bar.

The named defaults are ready for the config store. Tests:
`unit/ptt.test.ts` (the gesture, the ring, the pieces) and
`scripts/dev/debug-chat-ptt-qa.mjs` (CDP touch, 390×844: a hold sends one
line with one STT call, a slide-away cancels, a tap sends nothing).

## Where the speech comes from

Every mic and sound on the page is moving under one hub, Li's; phase 0 only
observes ([li-sound-hub.md](li-sound-hub.md), flag `voice.li-hub`).

Voice mode uses the page's one mic session, `__lkMic`
([dev-debug-widget.md](dev-debug-widget.md), packages/debug-chat
`mic-session.ts`). This is the same VAD, echo guard and STT as the chat mic:

- **The local streaming STT first** ([local-stt.md](local-stt.md)): when
  `lk:agent-local-stt` is set, finals come from his Mac (~50–190 ms after the
  end of speech). Otherwise they come from the cloud route `/api/debug/stt`,
  which is open to any signed-in user.
- **Command taps** (`packages/debug-chat/src/mic-taps.ts`, on globalThis
  `__lkMicTaps`). Each final transcript is offered to the taps before the
  chat. A tap that returns true keeps it; voice mode does so only for a
  strict command. The registry lives outside the
  session, so a session migrated by a hot-swapped widget keeps the taps.
  `MIC_SESSION_V` 10 is the first session that consults them. An older
  session on the page (a hot widget built before this) never does, so voice
  mode reports the mic as failed.
- **The pin** holds the mic in active mode while voice mode is on. The first
  pin wakes a passive mic (`{ev: "wake", reason: "voice-mode"}`). The wake
  gate lets everything through. Empty or hallucinated finals no longer count
  towards passive, and the agent cannot set it passive.
- Voice mode turns the mic on if it was off, and off again when it ends. If
  the chat mic was already on, it is left on.
- `micSession()` now replaces only an *older* session, never a newer one, so
  an old bundle cannot downgrade it.
- A reload's auto-resume (`autoResume`) no longer toggles a mic that
  something else turned on while it waited on its permission check. Before,
  voice mode starting on a fresh page and the auto-resume both toggled, and
  the second toggle turned the mic straight off (found by the QA).

## Cues

The owner, 2026-11-05 23:40–23:41 JST: "语音识别完发出去消息的时候要有声音",
and the start and end of speech heard too, on VAD events rather than the mic
opening or closing. `packages/debug-chat/src/cues.ts`, tones from Web Audio, no
files and no TTS.

| Cue     | When                                                                      | Sound                                  |
| ------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `send`  | a spoken line went out (`submit` in DebugChat, `source: "stt"`): any path | 880 → 1320 Hz, 110 ms, peak 0.16       |
| `amend` | a spoken line asked to amend the last one (flag `stt.merge`, [dev-debug-widget.md](dev-debug-widget.md), "Continuous speech amends the last line") | 1046.5 Hz, 60 ms, peak 0.08 |
| `start` | speech confirmed: 250 ms voiced since the VAD's start                     | 523 → 784 Hz, rising, 90 ms, peak 0.05 |
| `end`   | the VAD ended an utterance that was kept                                  | 784 → 523 Hz, falling, 90 ms, peak 0.05 |

**Switches.** The chat's ⋯ menu, with the other voice settings: `lk:voice-cue-send`
and `lk:voice-cue-speech`, on by default, synced with the account
([prefs-sync.md](prefs-sync.md)). "Replies silent" (his mute,
`lk:agent-chat-speak`) silences all three, even with the mic on. A phone's hidden
page makes no cue (speak-rules.ts). `lk:voice-out` changes nothing: the cues play on
the page's AudioContext with either output. There are no quiet hours.

**One per what.** The send cue has one call, in `submit`, after the line went
out (`amend` takes its place on a line that joins the one before, follows its switch and rules, and adds nothing else): the join, Enter and the debounce all pass there, and a line that could not
be sent plays nothing until the send that works. Typed lines are silent. A start
cue plays at most once an utterance, and not within 1.5 s of the last start or end
(`CUE_START_GAP_MS`), so talk resuming after a pause does not chime again. A false
start plays nothing, because the VAD's start alone never plays it: `onMisfire`
comes before the 250 ms, or the frames never score as speech. Nothing plays for a
passive (wake-gated) utterance, so room talk never chimes; nor for a voiceprint
sentence, which must stay clean; nor for speech dropped by a hold or flushed by
turning the mic off. A command line kept by a tap (voice mode) was captured, so it
gets start and end, but no send cue: it was not sent.

**Not captured, and not costing his words.** The mic is open when a cue plays. It
is never held for one: `hold` drops the speech under way and pauses the VAD, which
would cut his first words. Instead:

- `pageCues().guard()` is on for the cue, the context's output latency and 150 ms
  more. Frames heard meanwhile stay in the audio, but do not count: not towards
  the noise floor, the speech level, the barge-in judge, the endpoint, or the
  speech that confirms an utterance.
- A VAD start inside the window is a **shadow capture**: the audio is kept from the
  start as always, but nobody hears of it (no ducking, no held send cancelled, no
  partial shown). 96 ms voiced after the window makes it a normal capture, audio
  whole. An utterance that ends without that is dropped: no upload, no transcript,
  no cue, `{ev: "cue-echo-drop"}` in the debug log. The cost: a reply under about
  100 ms of voice, begun inside the window and over by its end, is dropped.
- A send cue over a capture waits for the capture's end. Its tone would otherwise
  go into the recording.
- The start cue does play over his words, by design, so only with echo cancellation
  on (`lk:voice-aec`). With it off the start cue stays silent; end and send play.
- Start and end stay silent while Li reads a reply (a leak of her voice would
  chime). The send cue is mixed over the reading.

**Read-aloud.** A cue claims nothing from the page's audio owner (audio-claim.ts)
and goes straight to the context's destination: it does not pause the reading, and
the reading's ducking does not touch it. The context is suspended when the mic goes
off and nothing is read, but only once the last cue has ended (`idle`).

**A context that will not run.** A reload's auto-resume opens the mic with no tap,
and on Chrome the AudioContext then stays suspended until one. A cue that cannot
start within 250 ms is dropped, never left to sound at the next tap; while the mic
is on, any tap on the page starts the context.

Tests: `unit/voice-cues.test.ts` (a mocked AudioContext and fake VAD events). Not
tested by anything automatic, because it takes a speaker and a mic: how the tones
sound, and whether a real cue leaks into the real VAD. Its log line `cue-echo-drop`
counts the leaks the guard caught.

## Keep speaker awake

The owner, 2026-11-05 23:47 JST, after hearing the first sound of each line cut
on /words and outside Lianki too: keep the output device awake. **Whether this
fixes it is unproven until he has listened.** `packages/debug-chat/src/output-bed.ts`.

What was measured first (2026-11-05, 23:45 JST, files and a no-device Linux
container only): 257 production clips all have a lead-in (shortest 50 ms, French
and English about 420 ms, Chinese about 445 ms) with the first consonant in it,
and 57 plays through the real clip pool in Chromium reached the gain node whole.
The Kokoro clips open with 255–347 ms of literal zeros. So the suspect is a
device that sleeps on digital silence and wakes only on the first real sound.
That part is reasoning, not a measurement.

| Rule | How |
| ---- | --- |
| Level | white noise, peak -72 dBFS (RMS about -77), `BED_DBFS` |
| Route | its own AudioContext's destination: the same device as the clips (nothing sets a sinkId), and each stop closes the context |
| Starts | only inside a gesture. A line with no gesture plays at once with no bed (a reply arriving by itself, typed chat past the linger); the next tap while it plays starts the bed |
| Runs | while a line is due or playing and 60 s after (`LINGER_MS`, a card's thinking time), or while the mic is on, passive mic included |
| Pre-roll | `begin()` returns the ms to wait, 300 at most (`PREROLL_MS`): the sequencer (/words), `speak` (the reader) and `next` (Li) start their first line after it. Later lines wait for nothing |
| Stops | the linger's end, setting off, `pagehide`, the page hidden, `signOut()`. After a hide or sign-out only a new gesture starts it. /words' context and Li's (mic off) are suspended on the same exit, and /words' also on leaving /words |
| Setting | /words Settings, under Read aloud: "Keep speaker awake", `lk:voice-keep-awake`, device-local, on unless `"0"`. It governs /words, the reader and Li |

The first play after a pre-roll is past the tap, so the tap unlocks what will
play: /words plays a silent clip in a pool element (`unlockClip`), the reader
has its Play tap's `unlock` plus an empty utterance, and Li has its mic-tap unlock.

### The mic

- **No digital path.** The bed is connected to nothing but its own destination.
  It never calls `pageAudio().start`, so it takes no mic hold, adds no echo-guard
  text and leaves half-duplex alone. Measured: Chromium's real
  echoCancellation/noiseSuppression/autoGainControl path, fake mic file, four
  12 s runs with and without the bed: frame levels within 0.2 dB. (Fake output:
  this does not show the echo canceller seeing the bed as a playback reference.)
- **By air, on speaker.** -77 dBFS RMS is about 40 dB under the speech clips and,
  at a typical 80–90 dB SPL full scale near the mic, about 3–13 dB SPL: under any
  room's noise, so the VAD floor, AGC and STT should hear only the room. The
  energy VAD's `on` is 0.02 (-34 dBFS), 43 dB over the bed even with no air gap.
- **Echo canceller.** As remembered from WebRTC's AEC3 defaults (not checked in
  a run): playback under about -50 dBFS counts as inactive, so the bed should
  neither train the filter nor trigger suppression.

### What only a real device can tell

Whether the cut goes away at all. Whether -72 dBFS wakes each route: a Bluetooth
codec may drop it as inaudible, and a low OS volume attenuates it before the amp.
Whether it stays inaudible: by calculation a faint hiss is possible only at
maximum volume on sealed earphones in a silent room (lower `BED_DBFS` if so).
iOS: whether the unlocks hold across the pre-roll, whether a running context
changes the audio session, mixes with or stops other apps' audio, or counts
against the context limit (this page can hold several while the mic is on).

### Page audio while the mic captures (iOS)

While the chat mic captures, iOS's voice-processing unit ducks every other
sound on the page to near silence. A bare `<audio>` element is one of those
sounds: on 2026-11-07 the reader's word and sentence clips played on the
owner's iPhone (`playing`, currentTime advancing, volume 1) and nothing was
heard. Li's voice was audible because voice-out.ts routes its element through
the voice AudioContext. So the reader does the same: while the mic is on and
that context runs (`readRoute`, lib/read/speaker.ts), its clips play in a pair
of elements routed into that context; otherwise a bare pair, as before. The
mic does not suspend the context while page audio plays (MicButton
`suspendIdle`). The ringer switch was ruled out on the device; the bed's own
context does not cause it.

Battery: by reasoning only, not measured. While the bed runs the audio path
cannot power down, on top of a small noise loop. With the mic on it is already
up for capture, so the bed adds little. Without the mic the cost is bounded by
the 60 s linger, and it never runs hidden, so it cannot drain a locked phone.
The passive mic is the longest case.

## Safety: what voice can reach

Only the six `VoiceActions`: move, grade, show, read, undo and exit (which
turns voice mode itself off). Nothing deletes a list or a card. Nothing
changes another setting or touches the account. A double tap's sheet, list
menus and the import pages cannot be reached by voice. Grading is in scope
because the owner asked for it, and Undo takes a grade back (on /words; on
/review a page card's grade is taken back by grading it again later). Each
screen reaches only what it registered, and what is not a command reaches
nothing but the chat.

## Files and tests

| File                                       | Role                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `lib/words/voice-commands.ts`              | grammar, normalizing, matcher, echo check (pure)            |
| `lib/words/voice-dispatch.ts`              | utterance → outcome → one of the screen's actions; `voiceTap` (pure) |
| `lib/words/voice-access.ts`                | flag + owner → `on` / `preview` / `off`                     |
| `lib/words/voice-mic.ts`                   | browser glue to `__lkMic` (lazy import)                     |
| `packages/debug-chat/src/voice-merge.ts`   | continuous speech amending the last line (flag `stt.merge`); a kept command keeps lines apart |
| `packages/debug-chat/src/mic-taps.ts`      | command taps and pins on the page's mic                     |
| `app/(app)/words/VoiceMode.tsx`            | the hook, the switch (`useVoicePref`), the badge, its labels; any screen |
| `app/(app)/review/ReviewClient.tsx`        | /review's registration: the grades and exit                 |
| `unit/voice-commands.test.ts`              | grammar, fuzz, sentences, echo, the wiring, access          |
| `unit/mic-taps.test.ts`                    | taps, pins, the session consulting them, no downgrade       |
| `scripts/qa/qa-voice-mode.mjs`             | end to end, desktop and phone, silent: text fixtures to the taps, fake mic, muted |

```bash
QA_BASE=http://localhost:<port> QA_EMAIL=<an account holding dev> \
  bun scripts/qa/qa-voice-mode.mjs
```

The QA never plays anything. Its transcripts are text handed to
`__lkMicTaps.offer`, which is where a final transcript arrives, and it fails
if anything reaches `/api/debug/stt`.
