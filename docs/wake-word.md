# Wake word "Linky": a gate before speech-to-text

The owner asked for this on 2026-10-30 (23:18–23:21 JST, in-app chat). In
noisy places the mic sends noise, other people's speech and our own TTS
replies to STT, and the agent answers them as if he had said them. The fix is
a passive mode. In passive mode the phone listens on-device for "Linky" (the
Lianki partner) and sends nothing to STT until it hears it. Speaker
verification is an optional second check. This page covers the options, a
recommendation, where the gate sits in the mic pipeline, the state machine,
and how to evaluate it. Research and a first offline measurement were done on
2026-10-31.

## Candidates

| Engine                                                                                  | In a phone browser                                                                                                             | Size on device                                                                | CPU / battery                                                                              | Custom "Linky"                                                                                              | Licence                                                                                                                                                                                                   | Published FA / FR                                          | Accents (zh / ja / en)                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **sherpa-onnx KWS** (k2-fsa, Zipformer transducer, `kws-zipformer-zh-en-3M-2025-12-20`) | Yes. Official WASM build (`wasm/kws`), the same project as our SenseVoice server                                               | 5.4 MB int8 (encoder 4.6 + decoder 0.76 + joiner 0.09), plus the WASM runtime | RTF 0.008 on one Mac core, measured. Run per utterance it costs about 0 when quiet (below) | **No training.** You write the word as phones or pinyin in a text file, and can list several pronunciations | Apache-2.0 code. The model card says Apache-2.0, but it was trained on GigaSpeech/WenetSpeech, which have research-use terms                                                                              | None published. Ours is below                              | **Best fit.** One model covers English phones and pinyin, so "林琪 lín qí" and "lin-ki" are their own entries. No Japanese model; Japanese "リンキー" is covered by an English-phone entry |
| **openWakeWord** (dscripka)                                                             | Unofficial ports only (`openwakeword-web` and `openwakeword_wasm` on onnxruntime-web). Upstream FAQ says no JS port is planned | ~2.5 MB shared (mel 1.1 + embedding 1.3) + 0.2–1.7 MB per word                | Continuous: every 80 ms frame goes through mel and embedding. Light, but always on         | Colab, under 1 h; positives are 100% synthetic TTS                                                          | Code Apache-2.0. **Pretrained models CC BY-NC-SA** (our own trained model would be ours)                                                                                                                  | Target FR < 5 %, FA < 0.5/h                                | English-only TTS for training data, so Chinese and Japanese accents are only what Piper's English voices give. Weak for us                                                                 |
| **Hey Buddy** (painebenjamin)                                                           | Yes, built for it: onnxruntime-web, `hey-buddy-onnx`                                                                           | Small (96-dim, 2-layer head) on openWakeWord-style embeddings                 | Continuous, like openWakeWord                                                              | `heybuddy train "linky"`: 100k Piper positives + 100k phonetic adversarials, GPU hours                      | Apache-2.0 code **and** models. Datasets CC-BY 4.0                                                                                                                                                        | None published (default target FA 0.5/h)                   | Same English-TTS limitation. Small project (44 stars, last push 2025-07)                                                                                                                   |
| **microWakeWord** (OHF-Voice / ESPHome)                                                 | Not as is: TFLite-Micro for ESP32. Would need LiteRT.js or a port                                                              | **~55–60 KB** per word                                                        | Lowest of all (built for microcontrollers)                                                 | Notebook with Piper samples. README: the notebook's output "will most likely not be usable" without tuning  | Apache-2.0                                                                                                                                                                                                | okay_nabu v1: FR 2 %, FA 0.12–0.19/h (synthetic positives) | English TTS training, same as above                                                                                                                                                        |
| **Porcupine** (Picovoice)                                                               | Yes (WASM web SDK)                                                                                                             | ~1 MB                                                                         | Very low                                                                                   | Console, seconds; zh and ja models exist                                                                    | **Closed engine and models, needs an AccessKey checked online.** The free tier ended 2026-06-30 (Picovoice email to users, quoted on the Home Assistant forum: "There is no non-commercial tier planned") | Vendor: < 1 FA per 10 h                                    | Good, but **ruled out** by the licence and the end of the free tier                                                                                                                        |
| **Vosk** grammar `["linky","[unk]"]` (vosk-browser)                                     | Yes (WASM in a Worker)                                                                                                         | 40–50 MB small model per language                                             | Full Kaldi decoder running continuously: heaviest                                          | None (grammar)                                                                                              | Apache-2.0                                                                                                                                                                                                | None for KWS. Grammar mode forces near-misses onto "linky" | One model per language. vosk-browser last pushed 2025-12                                                                                                                                   |

Not adopted: Snowboy (dead), Mycroft Precise and Howl (unmaintained), and
matching "Linky" in the STT transcript. That last one fails in practice:
SenseVoice wrote our synthetic "Linky" as _Linki_, _Liney_, _Ley_, _林奇_
and _인기_, and it means uploading everything first, which is what we want to
avoid.

## Recommendation

1. **Gate: sherpa-onnx open-vocabulary KWS (zh-en 3M, int8) in WASM**, run on
   each Silero VAD segment in passive mode. There is no training step. The
   pronunciations to accept go in a text file, the licence is Apache-2.0, it
   is about 5 MB, and it is the same toolkit the Mac STT already uses.
2. **Second check: CAM++ speaker embedding** (3D-Speaker via sherpa-onnx,
   28 MB, Apache-2.0), enrolled from his saved clips. It is used for the
   active → passive decision ("not his voice") and to confirm a wake hit. It
   is loaded lazily and can be turned off.
3. If real-world false accepts are too high, the fallbacks are, in order:
   "Hey Linky" as the phrase, then a trained Hey Buddy model, which can use
   the TTS-made dataset from the evaluation.

## Where the gate sits

```
mic → Silero VAD (already on, 32 ms frames) → utterance Float32Array (onSpeechEnd)
                                                │
              active ───────────────────────────┴──▶ upload: local SenseVoice WS / /api/debug/stt (unchanged)
              passive ─▶ KWS(segment + 0.5 s pre-roll) ─ no hit ─▶ drop (nothing leaves the phone)
                                    └ hit ─▶ [speaker ok?] ─▶ cut audio after the keyword ─▶ upload rest; → active
```

- **Hook:** `createMic` gets an optional `gate(audio) → {pass, from?}`, called
  in `onSpeechEnd` before `d.upload`. In passive mode `d.stream()` returns
  undefined and partials are off, so nothing is streamed or uploaded while
  he is speaking. It stays pure and tested with fakes, as `mic.ts` is now.
  The rest after "Linky" goes to the local STT (docs/local-stt.md) when its
  socket is up, else to the cloud.
- **Running per segment, not as a stream, saves the battery.** The VAD is
  already running all the time. KWS work is about 1 % of the speech time
  natively, maybe 3–5 % in WASM on an iPhone (to measure), and only while
  someone is talking. A continuous streaming KWS would add a constant 3–5 %
  of one core. Load it lazily the first time passive mode starts, and cache
  it in the service worker.
- **Latency:** the hit is decided when the VAD segment ends, which happens
  anyway. "Linky, next word" goes through in one utterance, with the
  keyword's end time cutting off "Linky". A bare "Linky" switches to active
  mode and gives a short earcon or visual cue (no TTS).
- **Our own TTS:** the hold, AEC and text echo guard (`echo.ts`) stay as they
  are. In addition, a wake hit is ignored while `voice` is speaking, and
  replies should not say "Linky". In the test below, 600 of our word clips
  gave no hits.
- **iOS:** this only works while the PWA is in the foreground, because a
  backgrounded page loses the mic. That is a platform limit; no engine
  changes it.

## State machine

```
           tap mic / "Linky" hit (+ speaker ok)
   ┌──────────────────────────────────────────────┐
   ▼                                              │
 ACTIVE ── rejection score ≥ 3 ──────────────▶ PASSIVE
 (every utterance → STT → agent)              (only KWS on-device; nothing uploaded)
   │  ▲                                             │
   │  └─ an accepted utterance resets the score     │ explicit: "Linky, stop listening" / long-press
   └──── ACTIVE_IDLE (e.g. 3 min with nothing accepted) ──▶ PASSIVE
```

Each utterance in active mode gets a **rejection** label if any of these is
true: speaker score < threshold (someone else), `isHallucination` drop or
empty text, echo-guard drop, VAD misfire burst, or the agent judges it "not
addressed to me". For that, the reply model returns a no-reply marker rather
than an answer. Score: +1 per rejection, reset to 0 by an accepted utterance.
At 3 the state becomes passive. Every transition is logged as
`{ev: "wake", from, to, reason}` in the voice latency log, so his recordings
show why it switched. The UI shows the mode on the mic button: a filled ring
for active and a dashed ring for passive, waiting for "Linky".

## First measurement (2026-10-31, offline, files only, nothing played)

zh-en 3M int8, one thread, keywords file:

```
L IH1 NG K IY0 @LINKY      # English
L IH1 NG K IY1 @LINKY
L IH1 N K IY1 @LINKY       # "lin-kii": Chinese/Japanese realisation without ŋ
l ín k ì @LINKY            # pinyin readings
l ín q í @LINKY            # 林琪
```

| Set                                                                                                             | threshold 0.25 / score 1.0                     | 0.15 / 1.5  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Positives, Kokoro English voices (af/am/bf/bm + es/fr/hi accents), 34 clips                                     | 33/34 hit                                      | 33/34       |
| Positives, Chinese voices saying 林琪/林基 (14)                                                                 | 11/14 (English-phone entry only: 0/14)         | 13/14       |
| Positives in his own babble, 10 / 5 / 0 dB SNR (48)                                                             | 21 / 14 / 4                                    | 24 / 14 / 6 |
| **Negatives: his 30 real clips + 48 noisy copies (744 s)**                                                      | **0 hits**                                     | **0 hits**  |
| **Negatives: 600 of our TTS word clips, 7 languages (1875 s)**                                                  | **0 hits**                                     | **0 hits**  |
| Adversarial TTS (52): "Lianki…", Lincoln, link, linking, pinky, dinky, lean key, lanky, 林肯, 领取, 临期, 灵气… | 7 hits: _link here_, _lean key_, _lanky_, 临期 | 10          |

What this shows:

- **The product name "Lianki" never triggered**, nor did Lincoln, pinky,
  dinky or 林肯. That matters because both the owner and the agent say
  "Lianki" all the time.
- Real near-misses do trigger: "link he(re)", "lean key", "lanky", 临期,
  灵气. These come up in conversation, which argues for the speaker check and
  for "Hey Linky" if that turns out to be a problem.
- 0 false accepts in 44 minutes of real speech plus our own TTS. That is far
  too little data to claim a per-hour rate; the target is < 0.5 FA/h.
- Recall falls quickly when **his own voice is the noise** (babble of his
  clips at 10 dB or lower). That is the hardest case: a same-speaker
  "café". Real café babble from other speakers should be easier, and this
  needs measuring.
- Pitfalls found: Kokoro's Chinese voices drop the L of a Latin "Linky"
  (SenseVoice heard 应的, 인기), so Chinese-accent positives must be written
  in hanzi. Kokoro's Japanese voices did not load here (no unidic
  dictionary), so **Japanese-accent positives are still missing**. Use
  VOICEVOX ("リンキー"), or better, his own recordings.
- Speaker check (CAM++ zh-en, enrolled on 13 of his clips, tested on the
  other 13 against 40 TTS voices): at a 0.3 cosine threshold, 2 of his 13
  were rejected and 0 of 40 others accepted. His rejected clips are the short
  or garbled ones (possibly not his voice). Use it for the passive decision
  and as a wake confirmation, never as the only gate.

## Evaluation plan

Everything works on files. Nothing is played on the Mac.

1. **Positives (synthetic):** Kokoro / Piper / VOICEVOX render "Linky",
   "Hey Linky", "Linky, <command>" in en-US, en-GB and es/fr/hi accents,
   zh (林琪, 林基, Lin琪) and ja (リンキー, リンキ), at 2 speeds. Write them to
   `~/.cache/lianki-wake/pos/`.
2. **Positives (real), the deciding set:** 30–50 times him saying "Linky"
   and "Linky, …", recorded through the existing clip sink
   (`lk:debug-clip-sink`) on the phone. Do it in quiet, on the street and in
   a café, and include a lazy or fast "lin-ki".
3. **Negatives:** everything in `~/lianki-voice-clips` (his speech, never
   "Linky"), the `noisy.py` babble and pink copies, all agent TTS clips in
   `~/.cache/lianki-voice/out`, the adversarial list above, and at least one
   hour of real ambient recording (TV, café, a meeting) through the clip
   sink.
4. **Metrics:** FR per condition (quiet, 10, 5, 0 dB, babble, pink), FA per
   hour on the negatives, and adversarial hits. Sweep threshold and score
   (0.1–0.4 × 1.0–2.0) per keyword line. Choose the point with FA < 0.5/h
   and the lowest FR on his real recordings. Then re-score with the speaker
   check on.
5. **Device cost:** load the WASM KWS on his iPhone and log ms per segment
   and the model load time with the existing latency record. Compare a
   30-minute passive session against VAD alone with the battery panel.
6. **Tuning gate:** the mic only goes passive after 3 rejections or when
   the agent says so, and `lk:agent-wake` = `"0"` turns it off. Before
   relying on it in a café, his real-recording FR should be < 10 % and FA
   < 0.5/h.

The offline scripts: `scripts/local-stt/wake-gen.py` (the synthetic set,
Kokoro) and `scripts/local-stt/wake-eval.py` (sherpa-onnx KWS over it, his
clips, the noisy copies and the agent's TTS). The CAM++ speaker check
comes in a later PR.

## Implementation (2026-10-31)

| Piece | Where |
| --- | --- |
| State machine, the `LINKY` keyword (7 pronunciations), the cut after it | `packages/debug-chat/src/wake.ts` |
| The spotter: a Blob Worker running `@sherpaw/kws@0.3.0` (sherpa-onnx WASM, Apache-2.0) with the zh-en 3M model (fp32, 13 MB, pinned Hugging Face commit) | `packages/debug-chat/src/wake-kws.ts` |
| The gate on each VAD segment, before upload, only in passive mode | `createMic` `wake` (`mic.ts`) |
| Mode, rejections, lazy load, never-deaf fallback, `__lkMic.wake(mode)` | `mic-session.ts` |
| The button: dashed violet ring + "Linky?", zh/ja/en strings with translator context | `MicButton.tsx`, `ui-strings.ts` (`wakeStrings`) |
| The chat lane: `{type: "wake", mode: "active" \| "passive" \| "ignored"}`, relayed to the thread's pages, not stored; each owner line carries `wake` (its mode) | `lib/dev-eval.ts`, `workers/push/src/debug.ts`, `app/components/DebugEval.tsx`, `bun scripts/dev/eval.ts wake <mode>` |
| Browser end to end (fake mic from WAV files, nothing played) | `node scripts/dev/wake-word-qa.mjs --clip <wav> [--negative <wav>] [--save sent.wav]` |

- **Loading:** nothing loads until the mic first goes passive. Then about
  12 MB of runtime (jsDelivr) and 13 MB of model (Hugging Face) are
  fetched. Each file is checked against its SHA-256, including the glue JS,
  which is imported from a Blob after the check, and kept in the Cache API
  (`lk-wake-v1`). In Chromium the first load took 2.7–3.2 s on a fast line;
  after a reload, 0.4 s from the cache.
- **Cellular:** with nothing cached and `navigator.connection` saying
  cellular or Save-Data, the download waits. The mic stays active and the
  button notes "downloads on Wi-Fi". Safari has no `navigator.connection`,
  so there it downloads.
- **Cost:** 100–140 ms of Worker time per 3–5 s segment in headless
  Chromium (RTF ≈ 0.03), only while someone talks in passive mode.
- **The cut:** the words after "Linky" start at the last token's timestamp
  (`KEYWORD_TAIL_S = 0`). +0.25 s lost "what's" of "Linky, what's next?"; 0
  sent exactly "What's next?".
- **Rejections** are empty and hallucinated finals, and the agent's
  `ignored`. Echo drops (the agent's own voice) do not count.
- **Off switch:** localStorage `lk:agent-wake` = `"0"` means the mic is
  never passive.
- **Load timeout (2026-11-02):** `load()` gives up after `LOAD_TIMEOUT_MS`
  (15 s): the spotter is "failed" (`{ev: "wake-kws", error: "load-timeout"}`),
  the mic goes back to active (`kws-failed`), and an utterance that was
  waiting on it is sent as an active one would be (`unchecked`). The Worker
  keeps downloading; if it gets ready later, the next passive turn uses it.
  The 15 s applies everywhere: on cellular nothing uncached is fetched
  anyway. In `createMic`, a passive utterance never waits more than
  `WAKE_GATE_MS` (30 s) for its verdict, so a stalled check cannot hold back
  the transcripts after it in the ordered queue.
- **The agents see the mode:** each owner line carries `wake` (`active` /
  `passive`) and `wakeReason` (the WakeReason that put it there:
  `wake-word`, `rejects`, `tap`, `agent`, `kws-failed`, `mic-on`), and
  `eval.ts chat` prints both.

## Tuning on his voice (2026-11-02)

He reported "Linky" often not waking the mic (2026-11-01 23:53 JST,
Android; STT heard "Lenky"). The first setting, 0.25 / 1.0 with five
spellings, was tuned only on synthetic voices.

**There are no real "Linky" recordings of him yet.** All 211 clips in
`~/lianki-voice-clips` (the latest from 2026-10-31 23:26 JST) were checked by
their sidecar transcripts: none has him saying "Linky". So recall on his
own voice could not be measured. The positives below are the synthetic
set (46 Kokoro English/accented + 12 Chinese-voice 林琪/林基). The
negatives are his real clips, which is the set that decides false wakes.
The sweep used the browser's fp32 model and the whole segment plus 1 s of
silence, as `padForSpot` does. It ran on files only, with nothing played.

| Setting                                    | Positives (58) | +babble 10 dB | +babble 5 dB | **His clips (211)** | His noisy copies (48) | Adversarial (52) |
| ------------------------------------------ | -------------- | ------------- | ------------ | ------------------- | --------------------- | ---------------- |
| Before: 5 spellings, 0.25 / 1.0            | 46             | 43            | 39           | **0**               | 0                     | 9                |
| After: 7 spellings, 0.15 / 1.5             | 47             | 44            | 41           | **0**               | 0                     | 12               |

- The threshold barely matters on these sets. Across 0.05–0.30 × score
  1.0–2.0, his clips gave **0 false wakes at every point**; positives moved
  by at most 3. With 0 in 211, the 95 % upper bound is about 1.4 per 100
  clips, so the ≤ 1 per 100 target cannot be told apart from zero yet.
- **Added:** `L EH1 NG K IY0` ("Lenky") and `l ín k ī`. Neither changed a
  synthetic hit; they are for how he actually says it.
- **Not added: `l íng k ī`** (líng kī). With it, 2 of the 12 Chinese-voice
  positives were lost and none gained, at every per-keyword boost tried
  (0.5–2.5). It competes with the `l ín …` paths in the search.
- The cost is near-misses: 3 more adversarial hits (12 of 52). Watch
  `{ev: "wake-spot"}` for wakes he did not mean.
- **Next:** record 30–50 real "Linky" utterances through the clip sink
  (evaluation plan, step 2). Then rerun the sweep
  (`scripts/local-stt/wake-eval.py`) with an equal number of his
  non-Linky clips, and set the threshold from that.

## Sources

- sherpa-onnx KWS docs: https://k2-fsa.github.io/sherpa/onnx/kws/index.html
  · WASM: https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm/kws
- openWakeWord: https://github.com/dscripka/openWakeWord · browser write-up:
  https://deepcorelabs.com/open-wake-word-on-the-web/ ·
  https://github.com/dnavarrom/openwakeword_wasm
- Hey Buddy: https://github.com/painebenjamin/hey-buddy
- microWakeWord: https://github.com/OHF-Voice/micro-wake-word ·
  https://www.home-assistant.io/blog/2024/06/26/voice-chapter-7/
- Picovoice free tier end:
  https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
- vosk-browser: https://github.com/ccoreilly/vosk-browser
- 3D-Speaker CAM++ in sherpa-onnx: release `speaker-recongition-models`
