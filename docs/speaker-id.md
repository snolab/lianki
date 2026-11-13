# Who is speaking: tagging each final as owner, other or unknown

The owner asked on 2026-10-31 (03:29 JST): "distinguish who is speaking;
start simple". The goal is for the local STT server
([local-stt.md](local-stt.md)) to tag each final with
`speaker: "owner" | "other" | "unknown"`. Passive mode and the false-trigger
guards can then drop speech that is not his: other people in the room, and
the agent's own TTS coming back through the mic
([wake-word.md](wake-word.md), [stt-ab.md](stt-ab.md), "VAD sensitivity").

This page is an experiment. Nothing here changes his recognition. The
server and the widget are unchanged, and the plug-in below is a proposal.

## Result

**The simple version does not work. CAM++ does, from about 1 s of speech.**

| scorer                                               | EER, 0.5 s | 1 s      | 2 s      | 3 s      | whole clip |
| ---------------------------------------------------- | ---------- | -------- | -------- | -------- | ---------- |
| pitch only (F0 median and range)                     | 47%        | 51%      | 55%      | 58%      | 50%        |
| simple (pitch + spectral centroid + MFCC 1–12 means) | 45%        | 53%      | 47%      | 48%      | 40%        |
| **CAM++ embedding (sherpa-onnx, zh-en, 28 MB)**      | **6.8%**   | **3.6%** | **0.1%** | **0.0%** | **0.0%**   |

EER is the error rate at the threshold where false accepts equal false
rejects. 50% is a coin toss.

- **Pitch and simple spectral features are no better than chance** against
  these voices. The page's TTS voices span both registers. A pitch profile
  only tells him apart from voices pitched well away from his, and the
  MFCC means mostly carry the recording channel, not the person. No
  threshold gives a usable trade-off. At the threshold the enrollment sets
  (the 95th percentile of his own windows), 85% of the other voices pass.
- **CAM++ separates him from every other voice here** once it has 2 s of
  speech. From 1 s, the three-way tag below drops 3.6% of his utterances
  as "other". At 0.5 s it drops 8.5%, and 4% of other voices still reach
  "unknown" or "owner".
- It is cheap. One embedding takes 10 ms for 1 s of audio, 24 ms for 3 s
  and 74 ms for 10 s, on one M5 Max core. That runs alongside the
  SenseVoice final decode (about 85 ms), not after it.
- Running the model natively was not blocked. The sherpa-onnx Python
  package already in the STT venv loaded and ran the downloaded ONNX file
  like SenseVoice.

### CAM++ at fixed cosine thresholds

FR = his utterances rejected. FA = other voices accepted. "Unlabelled" = the
10 captures not meant for the agent (who spoke is unknown).

| length     | cosine ≥ | FR   | FR, pink noise 5 dB SNR | FA, all others | FA, TTS echo through the room | unlabelled called owner |
| ---------- | -------- | ---- | ----------------------- | -------------- | ----------------------------- | ----------------------- |
| 0.5 s      | 0.20     | 8.5% | 53%                     | 4.0%           | 11.5%                         | 65%                     |
| 0.5 s      | 0.30     | 27%  | 61%                     | 0.5%           | 4.0%                          | 41%                     |
| 1 s        | 0.20     | 3.6% | 17%                     | 3.0%           | 4.1%                          | 82%                     |
| 1 s        | 0.30     | 20%  | 50%                     | 0.1%           | 0.0%                          | 79%                     |
| 2 s        | 0.20     | 0.0% | 3.3%                    | 1.1%           | 4.4%                          | 86%                     |
| 2 s        | 0.30     | 9.3% | 47%                     | 0.0%           | 0.0%                          | 77%                     |
| 3 s        | 0.20     | 0.0% | 0.0%                    | 2.9%           | 5.0%                          | 100%                    |
| 3 s        | 0.30     | 13%  | 31%                     | 0.0%           | 0.0%                          | 100%                    |
| whole clip | 0.20     | 0.0% | 0.0%                    | 2.6%           | 2.1%                          | 86%                     |
| whole clip | 0.25     | 0.0% | 0.0%                    | 0.4%           | 0.4%                          | 76%                     |
| whole clip | 0.30     | 0.0% | 8.3%                    | 0.1%           | 0.0%                          | 58%                     |

The script prints 0.15, 0.25, 0.4 and 0.5 as well. The thresholds are a
fixed grid chosen in advance, not values fitted to his scores.

**Three-way tag: owner if cosine ≥ 0.3, other if below 0.2, unknown in
between.**

| length     | his speech → owner · unknown · other | other voices → owner · unknown · other |
| ---------- | ------------------------------------ | -------------------------------------- |
| 0.5 s      | 73% · 19% · 8.5%                     | 0.5% · 3.5% · 96%                      |
| 1 s        | 80% · 16% · 3.6%                     | 0.1% · 2.9% · 97%                      |
| 2 s        | 91% · 9% · 0%                        | 0% · 1.1% · 99%                        |
| 3 s        | 87% · 13% · 0%                       | 0% · 2.9% · 97%                        |
| whole clip | 100% · 0% · 0%                       | 0.1% · 2.5% · 97%                      |

**How short can a clip be?** About 1 s for the tag to be useful. Under
1 s it should say "unknown" rather than guess (below). Single-word replies
(はい, 好, yes) are 0.1–0.6 s, so they stay "unknown" and are never dropped.

**Noise hurts.** With pink noise at 5 dB SNR (his 10-29 clips through
`noisy.py`), "≥ 0.3" rejects half of his 1–2 s utterances. The "other below
0.2" side holds up better (17% at 1 s, 3% at 2 s), so in noise more of his
speech lands on "unknown". That is why passive mode should drop only
"other", and why active mode should never drop anything.

## Data (2026-10-31, all on this Mac)

- **Owner: 20 clips** in `~/lianki-voice-clips` with a reference
  (`refs-agent.json`), his speech to the agent on the iPhone, 3–21 s. These
  are scored 5-fold: enrol on 16 clips, test on the held-out 4. Each test
  clip is cut into up to three crops of 0.5, 1, 2 and 3 s that start at
  speech, and also scored whole. The pink-noise 5 dB copies of the
  held-out clips come from `~/.cache/lianki-stt/noisy-clips` (12 clips have
  them). The babble copies are mixed from his own voice, so they were not
  used.
- **Unlabelled: the 10 clips without a reference** (10-30 20:28–21:11 JST,
  captures not meant for the agent). Some may be him talking to someone
  else, some may be other people. They are reported only as the share
  called "owner" and are not in any FA/FR figure. CAM++ calls most of them
  his, which fits him talking in the room rather than to the agent. Only
  he can say.
- **Others: 142 recordings, all synthetic.** These are the 24 TTS echo
  sentences (`tts-echo`), the 15 word recordings (`tts-words`), and 103
  sentences of 3.2 s or longer from the page's TTS voices in nine languages
  (`~/.cache/lianki-voice/out/voice`, the first 12 per language by name).
  Each is used three ways: clean, and "through the room" at his speech
  level −6 dB and −20 dB (a 0.25 s synthetic reverb plus his own room's
  noise floor, taken from the quiet frames of his clips). The room copies
  give the others the same channel and noise as his clips, so a scorer
  cannot pass just by telling iPhone from MP3. The EER against the room
  copies alone is the same as against all of them (the "EER vs room only"
  column).

**Limits.** No other real person is labelled in this data. A real voice in
his room, on the same phone and possibly of the same sex and language, is
harder than a TTS voice. The 0% FA at ≥ 2 s is an upper bound on how good
it is, not a promise. Twenty owner clips from one phone in one week is
also little data. The deciding set is 20–30 clips of other people on his
phone, which the clip sink can capture with consent, and the field log
once the tag is on.

## Privacy design

Voice features and voiceprints are biometric data. The rule is that they
are computed on this Mac only, never uploaded, and never written anywhere
except one file.

- **One file:** `~/.cache/lianki-stt/speaker-profile.json`, mode 600. It is
  written only by `speaker-eval.py --enroll`. It holds the CAM++ mean
  embedding (192 floats), the simple profile, and the thresholds. Nothing
  else is persisted: the eval keeps features, embeddings and scores in
  memory, and it prints and writes (`--json`) only aggregate rates.
- **One command to delete it:**
  `rm ~/.cache/lianki-stt/speaker-profile.json` (or
  `speaker-eval.py --forget`). With no file, the tag is off.
- **Enrollment is explicit.** The owner runs `--enroll` himself. It reads
  only his labelled clips. Today no profile exists: this PR's run created
  one to test the mode-600 path and deleted it again.
- **The server sends only the label.** It sends no score, embedding or
  threshold. It does not log the label per utterance either; the log
  already carries only length and timings, never text.
- **Nothing reaches the repo, chat or Slack.** That covers features,
  embeddings, per-clip scores and per-clip tags. This page and the script
  output carry rates over sets only.
- **The model** (`3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
  28 MB, Apache-2.0, sha256 `aa3cfc16…ceba2`) lives in
  `~/.cache/lianki-stt/models/speaker/` next to SenseVoice. It runs in the
  same process and needs no network.

## Plugging it in (proposal, behind flags, off by default)

**Server (`scripts/local-stt/server.py`).** Add a new flag, `--speaker`.
If the profile file exists at startup, load CAM++ and the mean. In
`final()`, take the same `audio` the decode uses, run the embedding in the
executor next to the decode, and add one field to the final message:

```jsonc
{"t":"final","id":7,"text":"…","lang":"zh", …, "speaker":"owner"}   // "owner" | "other" | "unknown"
```

- Use "unknown" when the utterance has under 1 s of speech, when there is
  no profile, or when the score falls between 0.2 and 0.3. Leave the field
  out entirely when `--speaker` is off, so older widgets see no change.
- Score the whole utterance, not partials. The final is where the decision
  is made, and longer audio is more reliable.
- Advertise it in `ready` (`"speaker": true`) so the widget knows the field
  can come.

**Widget (`packages/debug-chat/src/local-stt.ts`, then `mic.ts`).** Pass
`speaker` through in the resolved result. Add one localStorage flag,
`lk:voice-speaker` (unset = ignore the field, as today).

- **Passive mode:** drop a final tagged `other`. It counts as a false
  trigger for the devLog and is never sent to the agent. `unknown` and
  `owner` go on to the wake-word check as before. The tag is a second
  check, never the only gate.
- **Active mode:** never drop. Flag `other` finals (a small "not you?" mark
  on the message, plus a devLog field) so the owner can see how often it
  fires and whether it is right.
- **Echo:** an `other` final that arrives while the agent's TTS is playing
  is the echo case. Log it next to the existing text echo guard, so the two
  can be compared before either one drops anything.

**Before turning it on by default:** collect his own field labels for a few
days with active mode flagging only. Check how often an `other` flag was
really him (FR) and how often room speech came back `owner` (FA), then
decide on passive dropping.

## Re-running

```bash
# CAM++ model, once (28 MB):
mkdir -p ~/.cache/lianki-stt/models/speaker && curl -fsSL \
  -o ~/.cache/lianki-stt/models/speaker/campplus_zh_en.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
~/.cache/lianki-stt/venv/bin/python -I scripts/local-stt/speaker-eval.py [--json /tmp/spk.json] [--no-cam]
```

The run takes about 75 s on the M5 Max. The script uses numpy, soundfile
and sherpa-onnx only. scipy is avoided because the shared venv pins numpy
1.26, which its scipy refuses (see [stt-ab.md](stt-ab.md)). F0 comes from a
plain YIN (60–400 Hz, threshold 0.15). MFCCs use 40 mel bands over 25 ms
frames with a 10 ms hop.
