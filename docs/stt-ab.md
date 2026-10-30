# Speech input A/B: which path, which endpoint, AEC or not

The owner's question (2026-10-31 01:09 JST): which combination gives the
fastest text that is still accurate enough, judged on what the text actually
comes out as. "Accurate enough" is his definition (01:1x JST): after he
speaks and the agent replies, no objection or correction means it was fine;
saying the same thing again means it was not.

The variables:

| | options |
| --- | --- |
| (a) mic processing | `getUserMedia` echoCancellation / noiseSuppression / autoGainControl on, or off |
| (b) transport | streaming to the local SenseVoice (partials every 0.4 s, #323), or the whole clip uploaded (local, or cloud Whisper with #321's `?hint=`) |
| (c) endpoint | the mic's own end of speech while streaming: 400 / **600** (today) / 800 / 1000 ms, or vad-web's 1400 ms |
| (d) denoiser | already rejected: DeepFilterNet made SenseVoice worse ([local-stt.md](local-stt.md), "Noise") |

## Recommendation

**Stream to the local SenseVoice, endpoint 600 ms, no denoiser, on every
device of the owner's, Android included.** AEC: undecided until clips
recorded both ways exist (none do yet); the toggle has to really turn
`echoCancellation` off to test the owner's complaint (see "AEC").

| path | speech end → text on screen | first text while speaking | CER (clear clips) | hallucinated messages (field) |
| --- | --- | --- | --- | --- |
| **local streaming, endpoint 600** | **≈ 0.67 s** (600 wait + 66 ms decode) + tailnet hop | **0.43 s** | **0.042** | 0 of 13 |
| local streaming, endpoint 400 | ≈ 0.47 s | 0.43 s | 0.053, 2 of 30 clips cut mid-sentence | – |
| local whole clip (no streaming) | ≈ 1.4 s wait + upload + ~90 ms | none | 0.042 (the same decode) | – |
| cloud Whisper turbo + `?hint=zh` (Android today) | ≈ 1.4 s wait + upload + ~0.8 s model (+ radio) | chunked partials | 0.17 (Workers AI as recorded), 0.12 (same weights on MLX with the hint) | **5 of 104 (5%)** |

Why:

- **Streaming loses nothing.** The final is SenseVoice decoding the whole
  utterance again, so it is the same text as the whole-clip decode: equal
  on **30 of 30** clips replayed through the real server. Streaming only
  removes the upload after the end and shows text from 0.43 s.
- **600 ms is the shortest endpoint that does not cut him.** At 400 ms two
  of the 30 clips were cut inside a sentence (「另外，|麦克风也要…」 became
  「应白。 麦克风…」; the long 21 s clip fell into three pieces) and CER on
  the clear clips rose from 0.042 to 0.053. 600, 800 and 1000 gave the same
  text on every clip, so anything longer only adds wait.
- **The cloud is both slower and less accurate.** Over the 14 clips that went
  to Workers AI, it scored 0.154 against SenseVoice's 0.088 on the same
  clips, and in the field it **read its own prompt back as speech twice**
  (「我说中文，有时夹杂日本語和English。」, the `?hint=zh` prompt from
  `lib/stt.ts`) and appended Whisper's subtitle credits three times
  (「感谢观看。」 ×2, 「文字幕志愿者 李宗盛。」). The mic's hallucination
  guard drops only a whole message that is a listed phrase, and 感谢观看,
  字幕志愿者 and the prompt are not on its list.
- **Restatement and correction are rare on both paths** (2% each on the
  cloud, see "Field metrics"); the cloud's real cost in the field is the
  hallucinated tails, not repeats.

So the widget can default to: `lk:agent-local-stt` set (streaming), endpoint
600, `lk:voice-aec` as it is until the A/B below.

**Since then (2026-10-31 01:41 JST on)** the Android streams to the local
SenseVoice too, and its field data changes one point: on his dictation, the
600 ms endpoint cut **18 of 93 messages** in the middle of a sentence. No
endpoint length fixes that cheaply, so the fix is to join the pieces
(see "VAD sensitivity").

## VAD sensitivity

The owner (about 03:00 JST): "is there a way to make the VAD more
sensitive?". `scripts/local-stt/vad-sweep.py` replays the clips and
synthetic mixes through the same Silero v5 and vad-web's start/end logic,
over a grid of settings:

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/vad-sweep.py --json /tmp/sweep.json
```

**The start threshold is already 0.3, not 0.5.** `MicButton.tsx` leaves
vad-web 0.0.30's defaults alone: `positiveSpeechThreshold` 0.3,
`negativeSpeechThreshold` 0.25, `minSpeechMs` 400, `preSpeechPadMs` 800,
`redemptionMs` 1400. The 0.5 in `mic.ts` (`SPEECH_FRAME_PROB`) only counts
speech for the hallucination guard.

### Recommendation

| parameter | today | recommended | why |
| --- | --- | --- | --- |
| `positiveSpeechThreshold` | 0.3 | **0.3** | 0.2–0.5 give the same text on all 20 clips; 0.5 holds back only 3 of 10 not-for-agent captures and 0–4 of 24 echoes, and hears fewer single words |
| `negativeSpeechThreshold` | 0.25 | **0.25** | – |
| noise-adaptive start (floor EMA + δ) | – | **no** | identical to the fixed 0.3 on every set, for δ 0.15/0.2/0.25 |
| `minSpeechMs` | 400 | **250** | single words heard 9/15 → **14/15**; no noise mix triggers more |
| `preSpeechPadMs` | 800 | **800** | the pad already covers the onset; shorter pads clip it (below) |
| `ENDPOINT_MS` | 600 | **600**, plus joining | longer endpoints rejoin only some of the field's cut sentences, at the cost of a slower final every time (below) |
| new: join window | – | **2.5 s** | when the next utterance starts within 2.5 s of the previous final, its text is appended to the same message (the owner asked for this, 02:04 JST: consecutive messages appended to the previous one) |
| new: blip guard | – | drop a lone short Latin word or 嗯/呃 | 26 of 183 local messages were 「Yeah.」「The.」「Don.」; a VAD setting cannot tell them from real words (below) |

Latency: none of this slows the final. vad-web fires `onSpeechStart`, where
streaming begins, on the first frame over the threshold; `minSpeechMs` only
decides at the end whether the utterance was a misfire, and the pad is
unchanged. The join window holds only the send to the agent; the text is on
screen as soon as each final arrives, 0.67 s after he stops.

### Clips and mixes (2026-10-31, 30 clips, all iPhone)

The owner's speech level is −26 dBFS (median over the speech frames of his
clips). The sets:

- **speech**: the 20 scored clips;
- **short**: 15 single words (好 对 是 不 行 没有 谢谢 はい いいえ どうぞ
  yes no good stop next), the word lists' own recordings at his level with
  faint room noise around them, a stand-in for one-word replies;
- **not-for-agent**: the 10 clips without a reference;
- **echo**: 24 of the word lists' example sentences (the voices the page plays)
  at −6 dB (no AEC) and −25 dB (an echo canceller's residue);
- **noise**: pink (2 levels), brown, mains hum, clicks, the send tick, and 3
  far babbles of the example sentences at −15 dB.

Rows at the recommended start threshold (0.3); the full grid is in the
script's output:

| min ms | pad ms | speech CER | onset clipped | short words heard · transcribed right | not-for-agent triggered | echo −6 · −25 dB | noise triggered |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400 (today) | 800 (today) | 0.065 | 2/20 | 9/15 · 6 | 10/10 | 24/24 · 21/24 | 3/9 (the 3 babbles) |
| **250** | **800** | **0.065** | **2/20** | **14/15 · 8** | **10/10** | **24/24 · 22/24** | **3/9** |
| 150 | 800 | 0.065 | 2/20 | 15/15 · 9 | 10/10 | 24/24 · 22/24 | 3/9 |
| 250 | 400 | 0.076 | 2/20 | 14/15 · 10 | 10/10 | 24/24 · 22/24 | 3/9 |
| 250 | 200 | 0.077 | 3/20 | 14/15 · 9 | 10/10 | 24/24 · 22/24 | 3/9 |
| 250 | 0 | 0.111 | 8/20 | 14/15 · 6 | 10/10 | 24/24 · 22/24 | 3/9 |

And the threshold at min 400 / pad 800: 0.5 and 0.45 hear 8/15 single words
and trigger on 7/10 not-for-agent clips and 20–21/24 quiet echoes; 0.2 hears
12/15 and triggers on everything 0.3 does.

What this says:

- **Missed speech is not the threshold.** No setting missed any of the 20
  real clips, and 0.2 is no better than 0.3 on them. What fails is
  **`minSpeechMs` 400 against one-word replies**: はい has 128 ms of Silero
  speech, 不 224, 是 256, 行 and どうぞ 320, so vad-web calls them misfires
  and nothing is sent. 250 lets all but はい through; 150 lets はい through
  too, but leaves no margin above a cough.
- **The pre-pad matters, and 800 is right.** With the audio from the first
  frame over the threshold only, 8 of 20 clips lose their first characters
  (CER 0.111). 200 ms before onset brings that to 3 (0.077), 400 to 2 (0.076),
  800 to 2 (0.065). Longer than 800 cannot be tested: the saved clips start
  800 ms before the phone's trigger. On single words 400 transcribes one or
  two better than 800 (the room noise in front confuses SenseVoice), but the
  sentences decide.
- **False triggers are speech, and no VAD setting stops them.** Pure noise
  (pink, brown, hum, clicks, the send tick) triggered nothing at any
  setting. Everything that did trigger was a voice: others in the room, far
  babble, the agent's own voice even at −25 dB. Silero is level-blind by
  design. Even 0.5 lets 7 of 10 not-for-agent captures and 20 of 24 quiet
  echoes through. Those are for the echo canceller and capture hold, the
  text echo guard, and in passive mode the wake word (#350). In active mode
  they will reach the agent whatever the VAD does.
- **The blips are not separable by the VAD either.** On the not-for-agent
  clips that came out as 「Yeah.」「So.」, Silero saw 320–800 ms of speech at
  a mean probability of 0.27–0.47, the same as the real single words
  (128–640 ms, 0.14–0.48). The guard has to be on the text: SenseVoice's
  lone 「Yeah.」「The.」 in a Chinese conversation.

### Field: cut sentences and blips (Android, local, 01:41–03:08 JST)

From the chat log, using the same field metrics as below:

| STT path | spoken | restated | corrected | one-word blips | next spoken ≤ 8 s |
| --- | --- | --- | --- | --- | --- |
| local SenseVoice, endpoint 600 (Android + iPhone) | 183 | 15 (8%) | 3 (2%) | **26 (14%)** | 88 (48%) |
| cloud fallback during that time (Whisper style) | 17 | 0 | 2 | 0 | 2 |
| cloud Whisper, vad 1400 (Android before 01:41 JST) | 107 | 2 (2%) | 3 (3%) | 1 (1%) | 14 (13%) |

Hand-checked:

- From 01:41 to 02:05 JST and again around 02:32 JST, most of the "spoken"
  messages are conversation in the room, not to the agent. Active mode took
  it all down: the false-trigger case the wake word is for.
- In his dictation to the agent after 02:03 JST (93 messages), **18 are the
  second half of a sentence the 600 ms endpoint cut**: a noun phrase split
  from its noun, one sentence in four pieces, and his question about the VAD
  itself, cut in two. Whisper at 1400 ms cut 4 of 107.
- The pauses at those cuts, estimated from the send times (gap minus the
  second piece's length at ~4.5 characters a second, minus the 600 ms), run
  from about 0.2 to 3.8 s. An endpoint of 1000 ms would have rejoined about
  8 of the 18, 1400 ms about 12, and either adds 0.4–0.8 s to every
  utterance. **Joining** instead, when the next utterance starts within
  2.5 s of the previous final (a pause of up to ~3.2 s), would have rejoined
  17 of the 18 without making any final slower. These pause figures are
  rough (no Android clip was saved to measure them), so take 2.5 s as the
  starting value and tune it on the devLog.
- Real recognition repeats on local: three runs (a model name, 不介意 heard
  as 不建议, 切到 heard as 签到), about 3% of his dictation. On the cloud
  before it: one (DOT heard as BOT). The rest of the 15 "restated" are
  blips and fragments.

**For the widget (hot-loadable):**

```js
// MicVAD.new options (MicButton.tsx silero)
{ positiveSpeechThreshold: 0.3, negativeSpeechThreshold: 0.25, minSpeechMs: 250, preSpeechPadMs: 800, redemptionMs: 1400 }
// mic.ts: ENDPOINT_MS 600 (unchanged)
// new: JOIN_MS 2500: when onSpeechStart comes within 2.5 s of the previous final (and the
//   agent's reply has not started), the new final is appended to that message, not sent anew
// new: blip guard: drop a final that is one Latin word of ≤ 8 letters or only 嗯/呃,
//   except yes / no / ok / okay / good / stop / next / thanks
```

## Whispering

The owner (03:44 JST): "set up the VAD settings to listen to my whisper",
for talking to the agent at night. `scripts/local-stt/whisper-eval.py`:

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/whisper-eval.py \
  --since 2026-10-30T18:40:00Z --kws <the #350 KWS model dir> [--whisper]
```

**No real whispers yet.** The 18 clips that came in from 03:45 to 04:01 JST
(iPhone, all with `aec: true`) are normal speech. Their voicing (the
pitch autocorrelation peak over Silero's speech frames) is 0.61–0.77, the
same as his older clips (median 0.70), at −19.6 to −29.8 dBFS. The script
flags a clip under 0.45 as whispered. Until real ones arrive, the numbers
below come from **synthetic whispers**: his 20 scored clips whisperized
(LPC re-synthesis on white noise, so the formants stay and the pitch goes;
voicing 0.30) and set 20 dB under his voice (−46 dBFS). That is a stand-in.
Real whispers also change timing and articulation.

### What breaks on a whisper

| | today's settings | whole clip, no VAD |
| --- | --- | --- |
| SenseVoice CER on the synthetic whispers | 0.425, 9 of 20 cut in pieces | 0.237 |

Recognition itself drops (0.065 → 0.237), but the **VAD and the endpoint
lose more than the recognizer does**. Silero gives whispered speech a mean
probability of 0.46 where it gave his voice 0.9. The 600 ms endpoint, at a
threshold of at least 0.35, then ends the utterance inside words.

### Measured (synthetic whispers, and the same settings on his normal voice)

| input | VAD positive / min ms | endpoint threshold | endpoint | whisper CER, split | normal voice CER, split |
| --- | --- | --- | --- | --- | --- |
| as is (today) | 0.3 / 250 | ≥ 0.35, floor + 0.25 | 600 | 0.425, 9/20 | 0.065, 1/20 |
| as is | 0.2 / 150 | ≥ 0.15, floor + 0.1 | 800 | 0.304, 5/20 | 0.067, 1/20 |
| +12 dB, soft limiter | 0.3 / 250 | ≥ 0.35 | 600 | 0.271 | 0.090 (limiter distortion) |
| AGC-like (slow, to −26 dBFS, ≤ +30 dB, limiter) | 0.3 / 250 | ≥ 0.35 | 600 | 0.276, 5/20 | 0.142, 4/20 |
| **AGC-like** | **0.2 / 150** | **≥ 0.15, floor + 0.1** | **800** | **0.255, 3/20** | **0.076, 1/20** |
| AGC-like | 0.2 / 150 | ≥ 0.15, floor + 0.1 | 1000 | 0.273, 2/20 | 0.076, 1/20 |

- **Gain helps Silero most.** Gain before the VAD raises its probability on
  a whisper from 0.46 to 0.76. Without gain, lowering the thresholds alone
  gets to 0.304.
- **Fixed gain hurts his normal voice.** +12 dB took the voiced clips from
  0.066 to 0.090, and +18 dB to 0.092. On the new real clips, +18 dB turned
  「你能不能允许我」 into 「能勿能允许话」. So gain belongs in a whisper mode,
  not always on.
- **Spectral tilt compensation hurts.** Pre-emphasis 0.97 made the VAD miss
  20/20 un-gained whispers, and 0.51 CER at +18 dB. A low-shelf boost gave
  0.43–0.88. Leave the spectrum alone.
- **Pre-pad:** 800 ms throughout. The onset was clipped on 4–6 of 20 whispers
  at every setting.
- **Normalizing only quiet utterances on the Mac** (speech under −36 dBFS
  brought to −26 before SenseVoice) is free: it changed no normal clip, but
  it adds little (0.237 → 0.231 whole-clip). The gain has to come before the
  VAD, on the phone.

**False-trigger cost.** Room noise at night levels (pink at 50 dB under his
voice, a fan at 35 dB under, mains hum) triggered nothing at any setting,
even at a positive threshold of 0.15 with +18 dB. Other people's normal
speech triggered 10 of 10 at every setting, as before. Next to a whisper
those voices are about 20 dB louder, so with whisper mode on in a shared
room the agent will hear them. In passive mode the wake word still gates
them; in active mode nothing does.

**Wake word.** No whispered "Linky" exists yet, so whether #350's KWS
(`kws-zipformer-zh-en-3M-2025-12-20`, threshold 0.25, score 1.0) fires on
a whisper is untested. On the 18 new real clips it raised no false wake
under any gain (0/18 for none, +12, +18 and AGC-like). A KWS trained on
voiced speech is expected to be weak on whispers, so with whisper mode on
the mic should stay active, or the tap on the mic should serve as the wake.

### Recommendation: a manual, device-local whisper mode

Every setting that helps the whisper costs something on his normal voice:
CER 0.065 → 0.076 and 200 ms more per final. So it should be a toggle, not
automatic. Store it as `lk:voice-whisper`: device-local, like the other
habit settings, since it depends on the room and the hour.

When `lk:voice-whisper` = "1":

```js
// before the VAD (Web Audio, on the mic stream): slow AGC to −26 dBFS, at most +30 dB,
//   gain never above what the loudest speech so far needs (no pumping in pauses), then a
//   soft limiter (DynamicsCompressor or tanh at 0.9 full scale)
// MicVAD.new: { positiveSpeechThreshold: 0.2, negativeSpeechThreshold: 0.15, minSpeechMs: 150, preSpeechPadMs: 800, redemptionMs: 1400 }
// mic.ts: ENDPOINT_MS 800, ENDPOINT_MIN 0.15, ENDPOINT_MARGIN 0.1 (ENDPOINT_MAX 0.8 as is)
// wake: stay in active mode while whisper mode is on (KWS on whispers unproven)
// no pre-emphasis, no tilt
```

When it is off, keep the settings from "VAD sensitivity" above.

An automatic hint is cheap and safe: the server can report the voicing of
each final (whispered = under 0.45). After two whispered finals in a row
with whisper mode off, the widget offers a one-tap 「切到耳语模式？」.

The owner still needs to record real whispers. About 10 whispered sentences
of 2 s or more and 5 whispered "Linky"s, in the quiet bedroom, with the
clip sink on. Then re-run the script with `--since` set to that session to
confirm or retune these numbers.

## Clip replay

`scripts/local-stt/ab-eval.py` replays every saved clip:

```bash
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/ab-eval.py \
  --ws ws://127.0.0.1:5193 --whisper --chat /tmp/lianki-chat-fast.jsonl --json /tmp/ab.json
```

- Silero v5, the very model vad-web 0.0.30 runs on the phone
  (`~/.cache/lianki-stt/models/vad-web-0.0.30/silero_vad_v5.onnx`; the script
  prints the curl if it is missing), scores each 32 ms frame. On those
  probabilities it replays the mic's endpoint (`mic.ts`: threshold = noise
  floor + 0.25 within 0.35–0.8, the floor an EMA of the frames before speech)
  for each length, and vad-web's own end (1400 ms under 0.25). A cut inside a
  pause starts a new utterance with vad-web's pre-pad since the restart, and
  one under 400 ms of speech is a misfire, as on the phone. The pieces are
  decoded by SenseVoice and joined.
- `--ws` streams the 600 ms pieces to the real server at real-time pace in
  the phone's own framing (pre-pad `0x02`, 32 ms `0x01` frames, `end`).
- `--whisper` runs whisper-large-v3-turbo on MLX with the route's
  `sttPrompt("zh")`, a stand-in for the hinted route: the cloud route itself
  needs the owner's session (`eval.ts`, which prompts his devices), so it was
  not re-run. The "as recorded" column is what Workers AI gave at the time
  (turbo without the hint, the 2026-10-29 clips).
- It needs `onnxruntime` next to the venv in [local-stt.md](local-stt.md)
  (`uv pip install onnxruntime`). `--whisper` needs numpy 2: the shared venv
  has numpy 1.26.4 since 2026-10-30 20:25 JST, which breaks `mlx_whisper`'s
  scipy import, so this run used a separate venv with the same packages.

**References.** No clip had a `<name>.ref.txt`. The agent wrote
`~/lianki-voice-clips/refs-agent.json` (20 clips), marked as the agent's, and
**not listened to**: audio is never played on this Mac, so each reference is
reconciled from SenseVoice, mlx-whisper and Workers AI plus context. That
biases CER towards the engines (SenseVoice is one of the voters), so the
absolute CERs are optimistic; the comparisons between endpoints (one engine,
different cuts) are not affected. Six are marked ambiguous; the owner's
correction is wanted only for those (a `<name>.ref.txt` wins):

| clip (UTC name) | JST | the agent's guess | unsure about |
| --- | --- | --- | --- |
| 2026-10-29T14-06-51-273Z-0 | 10-29 23:06 | 内容有药丸、麦克风、紧凑消息区、聚焦才朗读… | 药丸 or 腰丸; 聚焦才 or 聚焦采 |
| 2026-10-29T14-07-04-646Z-1 | 10-29 23:07 | 表天授权已修好，切应用不再重问。你还看到的？ | 表天; the end |
| 2026-10-29T14-08-05-945Z-2 | 10-29 23:08 | 现在用的云模型是哪个？ | 云 or 原 |
| 2026-10-29T14-08-30-722Z-4 | 10-29 23:08 | 它是内置支持多语言的吗？ | 支持 or 知识 |
| 2026-10-29T14-10-53-197Z-10 | 10-29 23:10 | 这个什么时候能修？我先停掉不必要的连接，别再弹授权，续授权的修复我提到最优先。 | mumbled |
| 2026-10-29T14-12-31-243Z-11 | 10-29 23:12 | How's the name? | English, 3 s |

Ten clips are unscored: 10-30 20:28 JST (Workers AI heard nothing), 20:53
(「Yeahello.」) and the eight from 20:57 to 21:11 JST (「阳光十。」「So.」
「我公说不是。」「S pencil.」「北看看近需不是亲个。」「人真讲能非手说说。」
「Ju believeee.」 and one empty), which read as speech not meant for the agent
or noise; Whisper made nonsense or its subtitle credits of all of them.

### Results (2026-10-31, M5 Max, 30 clips, all iPhone)

| mode | CER, 20 scored | CER, 14 clear | clips cut mid-sentence | wait after speech | final decode, mean / max |
| --- | --- | --- | --- | --- | --- |
| SenseVoice, vad-web end 1400 | 0.066 | 0.042 | 0/30 | 1400 ms | 90 / 280 ms |
| SenseVoice, endpoint 1000 | 0.066 | 0.042 | 0/30 | 1000 ms | 79 / 228 ms |
| SenseVoice, endpoint 800 | 0.066 | 0.042 | 0/30 | 800 ms | 84 / 245 ms |
| **SenseVoice, endpoint 600** | **0.065** | **0.042** | **0/30** | **600 ms** | **85 / 272 ms** |
| SenseVoice, endpoint 400 | 0.066 | 0.053 | 2/30 | 400 ms | 71 / 223 ms |
| mlx-whisper turbo + hint zh, whole clip | 0.198 | 0.119 | – | (1400) | 530 / 1726 ms |
| Workers AI as recorded (14 clips; SenseVoice on them 0.088) | 0.154 | 0.170 | – | (1400) | ~812 ms documented |

CER is capped at 1 per clip (a hallucinated paragraph counts as one wrong
clip, not twenty). Streaming at real-time pace (600 ms pieces, through the
server on this Mac): first partial mean 428 ms (max 467), end → final mean
66 ms (max 176), final equal to the whole-clip decode on 30 of 30.

Per clip (CER; pieces in brackets when the endpoint cut the clip):

| clip (UTC) | s | ref | 1400 | 1000 | 800 | 600 | 400 | whisper + hint | as recorded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10-29 14:06:51-0 | 14.0 | agent? | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.03 | 0.03 |
| 10-29 14:07:04-1 | 6.6 | agent? | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.16 |
| 10-29 14:08:05-2 | 5.5 | agent? | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.10 | 0.10 |
| 10-29 14:08:24-3 | 13.2 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 |
| 10-29 14:08:30-4 | 4.9 | agent? | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.27 | 0.27 |
| 10-29 14:08:52-5 | 21.2 | agent | 0.15 | 0.15 | 0.15 | 0.15 | 0.16 (3) | 0.05 | 0.05 |
| 10-29 14:09:40-6 | 12.6 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 10-29 14:09:44-7 | 3.5 | agent | 0.20 | 0.20 | 0.20 | 0.20 | 0.20 | 1.00 | 1.00 |
| 10-29 14:09:59-8 | 9.7 | agent | 0.03 | 0.03 | 0.03 | 0.03 | 0.09 (2) | 0.00 | 0.03 |
| 10-29 14:10:33-9 | 6.3 | agent | 0.08 | 0.08 | 0.08 | 0.08 | 0.08 | 0.00 | 0.08 |
| 10-29 14:10:53-10 | 9.9 | agent? | 0.40 | 0.40 | 0.40 | 0.37 | 0.26 | 0.83 | 0.23 |
| 10-29 14:12:31-11 | 3.1 | agent? | 0.27 | 0.27 | 0.27 | 0.27 | 0.27 | 1.00 | 0.00 |
| 10-30 11:26:47-0 | 5.4 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.33 | 0.20 |
| 10-30 11:27:28-1 | 14.1 | agent | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.00 | 0.00 |
| 10-30 11:28:58-3 | 5.7 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 10-30 11:29:23-4 | 4.2 | agent | 0.08 | 0.08 | 0.08 | 0.08 | 0.08 | 0.08 | 0.08 |
| 10-30 11:29:29-5 | 2.9 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.20 | 0.00 |
| 10-30 11:51:21-6 | 6.4 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 10-30 11:51:38-7 | 4.2 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 10-30 11:53:48-9 | 6.3 | agent | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Limits of the endpoint replay: the 18 clips from 10-30 20:28 JST on were
already ended by the 600 ms endpoint on the phone, so the audio after it is
gone and 800/1000 cannot differ from 600 there. The 12 clips of 10-29 have
vad-web's full 1400 ms tail, and none of them was cut at 600 either. Where
the endpoint does matter is long pauses inside a sentence, which the field
log shows exist (below): even 1400 ms cut 4 of 104 spoken messages on
Android mid-sentence.

## Field metrics

From the owner's chat log (`/tmp/lianki-chat-fast.jsonl`, 2026-10-30 20:28 to
2026-10-31 01:29 JST), per spoken message (`source: "stt"`), looking at the
next two owner messages within 90 s:

- **restated**: one of them shares at least half of the shorter one's
  character bigrams;
- **corrected**: one of them carries a correction phrase (不是, 我说的是,
  我是说, 不对, no I said, 違う, じゃなくて…);
- **hallucinated**: the message contains a stock Whisper phrase or the
  route's prompt;
- **split**: the next spoken message came within 8 s (one sentence cut in two
  by the endpoint, or just two short ones).

The path comes from the clip sidecar sent with the message (its `model`,
and `track` once the page sends it), else from the device and time
(`WINDOWS` in the script): the iPhone streamed to the local SenseVoice from
20:28 JST; the Android never had `lk:agent-local-stt`, so it is the cloud
route, and `lk:voice-aec` was the default (on) on both.

| STT path | spoken | restated | corrected | hallucinated | split ≤ 8 s |
| --- | --- | --- | --- | --- | --- |
| cloud Whisper + hint, vad 1400, AEC on (Android) | 104 | 2 (2%) | 2 (2%) | 5 (5%) | 14 (13%) |
| local SenseVoice, endpoint 600, AEC on (iPhone) | 13 | 0 | 1 (8%) | 0 | 3 (23%) |

Hand-checked:

The chat itself is not quoted here (the repo is public); the script prints
the flagged pairs for a local hand-check.

- **Restated, cloud (2)**: one is a follow-up, not a restatement. The other
  is real (10-31 01:05 JST): he spelled out a name with "dot" in it, the
  cloud heard "BOT", and he restated it three times.
- **Corrected**: the two cloud ones are that same run. The local one is a
  false positive inside the 20:57 JST series of captures not meant for the
  agent.
- **Hallucinated (5, all cloud, all real)**: the prompt read back twice
  (once as a whole message, once appended to an English sentence), 「感谢观看。」
  appended twice, 「文字幕志愿者 李宗盛。」 once.
- **Split**: on the cloud, 4 of the 14 are one sentence cut by vad-web's
  1400 ms (one in three pieces); the rest are separate sentences. On local,
  none of the 3 is a cut sentence (two are the 20:57 captures, one two
  separate questions).
- Not counted, and not a recognition error: 10-31 00:37–00:50 JST the Android
  mic took down conversation in the room that was not meant for the agent.
  That is the wake word's job (#350), not the endpoint's.

Too few local messages (13) to compare restatement rates; on what there is,
both paths are under the owner's threshold except for the cloud's
hallucinated tails and one misheard word. The replay decides the rest:
equal accuracy, so the fastest, which is streaming at 600.

## AEC

**No clip yet says how its mic was opened.** All 30 are from the iPhone; the
Android has posted none (the sink was not set there), and the page does not
send the track settings (`noteTrack` / `appliedSettings()` in
`voice-out.ts` are used for the devLog only). This PR makes the sink keep
them: the meta's `track` field, `{echoCancellation, noiseSuppression,
autoGainControl, sampleRate, channelCount}`, is saved in the sidecar
(`scripts/dev/clip-sink.ts`, known fields only), and `ab-eval.py` groups by
it. The page side is the widget's: `postClip(…, { …, track:
appliedSettings() })`.

**The toggle does not turn echo cancellation off today.** `lk:voice-aec =
"0"` selects `LEGACY_CONSTRAINTS`, which still has `echoCancellation: true`
and `noiseSuppression: true`; only `autoGainControl` and the capture hold
differ. On Android it is `echoCancellation` that puts Chrome in the
voice-call audio mode (the worse speaker the owner noticed, 2026-10-31 00:51
JST), so that side of the A/B needs `echoCancellation: false` (and then
`noiseSuppression: false` and `autoGainControl: false` too, to hear the raw
mic), with the capture hold so the agent's own voice is not transcribed.

**How many clips.** Per-clip CER varies by about 0.1 between clean
utterances. To tell a 0.1 difference in mean CER between two independent
sets (two-sided 5%, 80% power) takes about 16 clips a mode; a 0.05
difference about 60. So: **20 usable clips per mode** (40 in all) on the
Android, real sentences to the agent of 2 s or more, in blocks of 10
alternating on, off, on, off in the same room, so the noise is shared. The
field metrics above run on the same session as a second opinion. If AEC off
is not worse by more than 0.05 CER and does not let the agent's voice in,
the Android should default to off for the better playback.

## Follow-ups this found (not in this PR)

- Set `lk:agent-local-stt` on the Android: it is still on the cloud route,
  slower and with the hallucinations above.
- `HALLUCINATIONS` (`mic.ts`) lacks 感谢观看, 字幕志愿者 / 李宗盛 and the
  route's own prompt, and the guard drops only whole messages; the field
  shows them appended to real speech. Strip a trailing listed phrase too.
- Send `track` with each clip (above), then record the 20 + 20.
