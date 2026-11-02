# Voice mode on /words: spoken commands

The owner asked for this on 2026-11-02 at 20:06 JST, in the in-app chat:
"/words 单词列表要一个纯语音模式 — 用口令操作：上下左右、上一张/下一张，复习操作（评分等）也做成口令".
While voice mode is on, short spoken commands move through the list and grade
it. No wake word is needed.

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
| left     | 左 / 向左 / 左滑                        | left                   | ひだり             | a one-level ← swipe: **Hard**                         |
| right    | 右 / 向右 / 右滑                        | right                  | みぎ               | a one-level → swipe: **Good**                         |
| again    | 重来 / 忘了 / 不记得 / 不认识           | again                  | もう一度 / 忘れた  | grade Again                                           |
| hard     | 困难 / 难 / 很难 / 模糊                 | hard                   | 難しい             | grade Hard                                            |
| good     | 良好 / 记得 / 认识 / 记住了             | good                   | 正解 / 覚えた      | grade Good                                            |
| easy     | 简单 / 容易 / 太简单                    | easy                   | 簡単               | grade Easy                                            |
| show     | 显示答案 / 答案 / 看答案 / 翻面         | show answer, reveal    | 答え / 答えを表示  | reveal the current card                               |
| read     | 再读一遍 / 再读 / 重读 / 再说一遍 / 重复 | read again, repeat     | もう一回 / 読んで  | read the current card aloud again (as a tap does)     |
| undo     | 撤销 / 撤回 / 回退                      | undo                   | 元に戻す / 取り消し | Z: undo the last grade                                |
| exit     | 退出语音模式 / 关闭语音模式             | exit voice mode        | 音声モード終了     | turn voice mode off                                   |

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
  sentence. "我觉得下一张更难" does nothing.
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
  (`sayParts`): a whole word for Latin, anywhere for CJK. So "easy" read from
  "easy (not difficult)" never grades Easy, an English list's "good" never
  grades Good, and a Japanese 上 never moves the cursor. The cost: a grade
  word inside the focused card's meaning (简单 in 简单的) is not taken for
  that card; a synonym (容易, 右) still is. Exit is the one command never
  blocked.
- **"Linky, …" goes to the chat.** In voice mode, every other final
  transcript is kept from the chat. A command runs; anything else is shown
  as heard and nothing happens.

## Feedback

After each utterance a short glass line shows above the badge for 1.8 s. It
is a live region:

- a command: ✓ and its name ("↓ 下一张", "→ 良好", "已撤销上一次评分");
- not a command: 听到「…」：不是口令;
- a card's own word: 听到「…」：这是卡片上的词，没有执行;
- a grade with no card loaded yet: 还没有可操作的卡片.

The strings are the `words-voice-mode` dictionary
(`app/(app)/words/voice-mode.content.ts`), 16 locales, each with its
context line.

## Where the speech comes from

Voice mode uses the page's one mic session, `__lkMic`
([dev-debug-widget.md](dev-debug-widget.md), packages/debug-chat
`mic-session.ts`). This is the same VAD, echo guard and STT as the chat mic:

- **The local streaming STT first** ([local-stt.md](local-stt.md)): when
  `lk:agent-local-stt` is set, finals come from his Mac (~50–190 ms after the
  end of speech). Otherwise they come from the cloud route `/api/debug/stt`,
  which is open to any signed-in user.
- **Command taps** (`packages/debug-chat/src/mic-taps.ts`, on globalThis
  `__lkMicTaps`). Each final transcript is offered to the taps before the
  chat. A tap that returns true keeps it. The registry lives outside the
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

## Safety: what voice can reach

Only the six `VoiceActions`: move, grade, show, read, undo and exit (which
turns voice mode itself off). Nothing deletes a list or a card. Nothing
changes another setting or touches the account. A double tap's sheet, list
menus and the import pages cannot be reached by voice. Grading is in scope
because the owner asked for it, and Undo takes a grade back.

## Files and tests

| File                                       | Role                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `lib/words/voice-commands.ts`              | grammar, normalizing, matcher, echo check (pure)            |
| `lib/words/voice-dispatch.ts`              | utterance → outcome → one `VoiceActions` call (pure)        |
| `lib/words/voice-access.ts`                | flag + owner → `on` / `preview` / `off`                     |
| `lib/words/voice-mic.ts`                   | browser glue to `__lkMic` (lazy import)                     |
| `packages/debug-chat/src/mic-taps.ts`      | command taps and pins on the page's mic                     |
| `app/(app)/words/VoiceMode.tsx`            | the hook and the badge                                      |
| `unit/voice-commands.test.ts`              | grammar, fuzz, sentences, echo, the wiring, access          |
| `unit/mic-taps.test.ts`                    | taps, pins, the session consulting them, no downgrade       |
| `scripts/qa/qa-voice-mode.mjs`             | end to end, desktop and phone, silent: text fixtures to the taps, fake mic, muted |

```bash
QA_BASE=http://localhost:<port> QA_EMAIL=<an OWNER_EMAILS address> \
  bash scripts/qa/with-muted-mac.sh node scripts/qa/qa-voice-mode.mjs
```

The QA never plays anything. Its transcripts are text handed to
`__lkMicTaps.offer`, which is where a final transcript arrives, and it fails
if anything reaches `/api/debug/stt`.
