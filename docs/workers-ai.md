# Workers AI

Every LLM and TTS call in the app goes to Cloudflare Workers AI. There is no
OpenAI dependency left at runtime — `lib/workers-ai.ts` is the only place that
knows about the provider.

## Setup

```bash
CLOUDFLARE_ACCOUNT_ID=...   # dashboard → account id
CLOUDFLARE_AI_TOKEN=...     # API token with Workers AI read/run
```

`CLOUDFLARE_API_TOKEN` (the name wrangler already uses) is accepted as a
fallback, so a deploy token works — but prefer the AI-specific name, which can be
scoped to Workers AI alone. Without both, the AI routes return 500 with
`Workers AI is not configured: …`; the blog index degrades to untranslated text
instead, which is its documented behavior.

Models are env-overridable, so a model change needs no deploy of new code:

| Env | Default | Replaces |
| --- | ------- | -------- |
| `WORKERS_AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `gpt-4o-mini` |
| `WORKERS_AI_MODEL_HQ` | `@cf/openai/gpt-oss-120b` | `gpt-4o` |
| `WORKERS_AI_TTS_MODEL` | `@cf/myshell-ai/melotts` | `tts-1` |

Speech to text is not env-overridable: its models are a whitelist in
`lib/stt.ts` (see "Speech to text" below).

| STT model | role | USD / audio minute | neurons / min |
| --- | --- | --- | --- |
| `@cf/openai/whisper-large-v3-turbo` | default | 0.000513 | 46.63 |
| `@cf/openai/whisper` | fallback | 0.000453 | 41.14 |
| `@cf/deepgram/nova-3` | owner's `?model=` / bench only | 0.0052 (REST); 0.0092 over websocket | 472.73 |

From [the pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/)
on 2026-10-29, at $0.011 per 1,000 neurons above the free 10,000 a day. The
page rounds both Whispers to $0.0005; the figures above are the neurons
worked out, and match `wrangler ai models --json` for turbo and Nova-3.

## Why REST and not a binding

Production runs on **Vercel** behind Cloudflare's proxy (`x-vercel-id` is
present on lianki.com), not on Workers — so there is no `env.AI` binding to bind
to. These are account-scoped REST calls, which work identically from Vercel, from
`wrangler dev`, and locally.

## Why no `workers-ai-provider`

The native AI SDK provider (`workers-ai-provider@4`) requires `ai@^7` and
`@ai-sdk/*@^4`; this app is on `ai@6`. Adopting it would drag a major SDK upgrade
into an unrelated change.

It is not needed anyway: Cloudflare exposes an **OpenAI-compatible** endpoint at
`/accounts/<id>/ai/v1`, so both the `openai` SDK and `@ai-sdk/openai` work with
nothing but a `baseURL` swap. That is why the chat migration is a one-line change
per route.

## TTS is the part that actually changed

The compatibility layer covers `/chat/completions` and `/embeddings` only — **not
audio**. Speech uses the native `/ai/run/<model>` endpoint, and MeloTTS is not a
drop-in for `tts-1`:

> **Cloudflare's model docs are wrong about the response, in two ways.** They
> say binary MP3 with `content-type: audio/mpeg`. Verified against the live API,
> it is actually a **JSON envelope** — `{"result":{"audio":"<base64>"},"success":true}`
> — and the decoded bytes are **WAV** (`RIFF`), not MP3.
>
> Both mattered: the first version of this client *rejected* a JSON
> content-type as an error envelope, so every TTS request would have failed in
> production while passing every test written from the docs. And the routes
> declared `audio/mpeg` for what is really RIFF. `workersAiSpeech` now decodes
> the envelope and returns `{ audio, contentType }`, with `sniffAudioType()`
> reading the container off the magic bytes so a future format change follows
> automatically. The binary path is kept, since the docs describe it and the API
> may yet behave that way.

- **No voice selection.** One voice per language. The six OpenAI voices
  (alloy/echo/fable/onyx/nova/shimmer) have no equivalent, so the voice picker in
  the self-intro UI was removed rather than left controlling nothing. Its i18n
  keys are still in `page.content.ts`, unused, in case voices return (Deepgram
  Aura on Workers AI has them, English only).
- **No speed control.** `speed` is still accepted and validated by
  `/api/self-intro/tts` so older clients keep working, but it does nothing. The
  native `<audio controls>` player still offers playback speed.
- **Language must be supplied.** `tts-1` inferred it from the input; MeloTTS
  takes a `lang`. Callers that already send `language` (self-intro) have it used;
  otherwise `resolveTtsLang()` guesses from the script — kana → `ja`, Hangul →
  `ko`, Han → `zh`. Supported: `en`, `es`, `fr`, `zh`, `ja`, `ko`. An unsupported
  locale falls back to the guess instead of being passed through, which the model
  would reject.
- **The TTS cache key now includes the provider.** Otherwise MeloTTS audio would
  be stored under a key naming an OpenAI voice, and cached `tts-1` clips would
  keep being served as if current — the same text sounding different depending on
  cache age, with nothing in the key to explain why. Existing cached entries are
  simply never hit again; they are not deleted.

## Speech to text

`POST /api/debug/stt` transcribes one utterance for the debug chat's mic
(`lib/stt-handler.ts`, `lib/stt.ts`, `workersAiTranscribe` in
`lib/workers-ai.ts`).

```
POST /api/debug/stt[?model=<id>][&lang=<bcp47>]
Content-Type: audio/webm | audio/ogg | audio/mp4 | audio/wav | audio/mpeg   (codecs= ignored)
<raw audio bytes, ≤ 2 MiB>

200 {"text": "…", "model": "@cf/openai/whisper-large-v3-turbo", "ms": 812, "language": "ja"}
401 guest · 405 not POST · 415 other type · 413 too large · 400 empty
429 over the limit (Retry-After) · 502 the model(s) failed
```

- **Who.** Any signed-in user. 120 requests per user per 10 minutes (the
  owner 600, for the bench). The limiter is `lib/rateLimit.ts`, as for the
  other AI routes: per isolate, so a spread-out burst can get a little more.
- **Model.** `?model=` is honoured for the owner only (`isOwner`), and only
  from `STT_MODELS`; everyone else, and any other value, gets the default.
  `?lang=` forces one language (optional). `?hint=zh|ja|en` is softer: it
  only picks the prompt (below); the mic sends it.
- **Fallback.** When the default fails, the fallback is tried once. A model
  the owner named explicitly is not replaced, so the bench sees real errors.
- **Logs.** `debug.stt` with model, bytes, ms, the transcript's length, the
  hint and the detected language. Never the audio or the text.

### Which model, and why

Measured on 2026-10-29 against the live API, with the word lists' recorded
example sentences (VOICEVOX ja, Kokoro zh/en, pulled from R2) and a WAV of
ja → en → zh back to back:

| clip | whisper-large-v3-turbo | whisper | nova-3 `language=multi` |
| --- | --- | --- | --- |
| ja 君を生かすも殺すも僕次第だ。 | exact | 君を**イカス**も殺すも**ぼく**次第だ | exact, but a space between every word |
| zh 学生去学校，肩上背着书包。 | exact | traditional, 竟然讓…書報 | **""** |
| en | exact | exact | exact |
| ja + en | en only; **both with the prompt** | romaji + en | en only |
| ja + en + zh | all three (zh mostly simplified) | garbled ja, en, zh | en only |

So the default is **whisper-large-v3-turbo**, which is also the cheapest.
**Nova-3 on Workers AI has no Chinese**: `language=zh` is refused ("No such
model/language/tier combination"), and `multi` or `detect_language` answers
an empty transcript. Its multilingual mode covers en/es/fr/de/hi/ru/pt/ja/it/nl.
It stays on the owner's list for the bench, since it may do better on the
owner's real ja/en speech; its Japanese spaces are removed (`joinCjk`).

Whisper settles on one language per window, so without a hint it dropped
the Japanese from a ja + en clip. `STT_PROMPT`, an `initial_prompt` that
itself mixes 日本語, English and 中文, fixed that, and did not leak into a
clip of silence. It is sent only when no `?lang=` is given.

**The hint (`?hint=`, 2026-10-30).** `STT_PROMPT` leads with Japanese, and
short Chinese clips from the owner came back as katakana nonsense
(「シェイカーマイカフォン。」). On his 12 saved clips (`~/lianki-voice-clips`,
10 zh, 2 en), a simplified-Chinese-led prompt (`sttPrompt("zh")`) beat
`STT_PROMPT` on every Chinese clip: simplified output instead of
traditional, 銀外 → 另外, punctuation kept, and no katakana (that clip came
back as English instead). `language: "zh"` was worse: it dropped all
punctuation and turned both English clips into Chinese. So the hint only
swaps the prompt, and Whisper still detects. ja and en keep `STT_PROMPT`.
The mic's hint (`packages/debug-chat/src/stt-hint.ts`) is the language of the
owner's last **typed** line (kana → ja, else Han → zh, else Latin → en), else
the device's language. Dictated lines never teach it, so a misheard line
can't make the next one worse.

Silence hallucinations (「ご視聴ありがとうございました。」, "Thanks for
watching" — Whisper's subtitle credits) are handled twice. Turbo is sent
`STT_ANTI_HALLUCINATION` (`condition_on_previous_text: false`,
`no_speech_threshold: 0.5`; both in its input schema, not yet verified live).
The mic then drops a final transcript that is one of `HALLUCINATIONS`
(normalized: NFKC, no punctuation or spaces) when the utterance had under
`HALLUCINATION_MAX_MS` of speech or a mean Silero probability under
`HALLUCINATION_MIN_PROB` (`isHallucination`, `packages/debug-chat/src/mic.ts`).
Each drop is a `stt-hallucination` devLog event with `{text, ms, prob}`, to
tune those two.

Request formats, all verified live: turbo takes JSON with the audio in
base64; Whisper and Nova-3 take the raw bytes with their Content-Type, Nova-3
its options as query parameters. MP3, M4A (AAC) and WAV were tested; WebM/Opus
(what Chrome's MediaRecorder makes) was not, as no encoder was at hand. If
turbo rejects it, Whisper is tried next.

Production is the Worker now, not Vercel, but it still calls the REST API
with `CLOUDFLARE_AI_TOKEN` (a Worker secret), like the other AI calls. An
`env.AI` binding would drop the token, but is not needed for this.

The bench for the owner's own voice is in
[dev-debug-widget.md](dev-debug-widget.md), "Voice clips and the STT bench".

## Not migrated

`intlayer.config.ts` still declares `provider: "openai"` with `OPENAI_API_KEY`.
That is **build-time** content translation run by the intlayer CLI, not app
traffic, and intlayer exposes no custom base URL to point at the compatibility
endpoint. It is inert unless someone runs an intlayer fill.

## Verifying

`lib/workers-ai.ts` is covered by `unit/workers-ai.test.ts` (fetch stubbed).

Verified against the **live** API on 2026-09-08 with the `lianki-workers-ai`
token:

- chat — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via the OpenAI-compatible
  endpoint, returns normally.
- TTS — `@cf/myshell-ai/melotts` for `ja` / `zh` / `en`, all HTTP 200 with real
  audio. This is what exposed the JSON-envelope and WAV findings above; the
  doc-based implementation would have failed on the first request.

Still unverified: **output quality**. Whether llama-3.3 keeps the JSON contract
the vocab routes parse under real prompts, and whether MeloTTS Japanese/Chinese
is good enough to learn from, needs a human to read and listen.

## Word-list audio is rendered offline

`/api/words/tts` serves pre-rendered clips first and generates with MeloTTS
only on a miss. The clips are open voices rendered once, on a laptop, for
every word, reading and example sentence in `public/words` and
`public/alphabets` (~63k clips, ~10 KB each), and stored in R2 under
`voice/<lang>/<sha256(lang \n text)>.mp3` (`lib/voice.ts`):

| lang                   | voice                               | licence / credit                        |
| ---------------------- | ----------------------------------- | --------------------------------------- |
| ja                     | VOICEVOX engine, No.7 (アナウンス) | free incl. commercial; credit "VOICEVOX:No.7" |
| en es fr it pt zh      | Kokoro-82M                          | Apache-2.0                              |
| ko                     | none yet — MeloTTS on demand        |                                         |
| de                     | Piper, de_DE-thorsten-high          | CC0                                     |
| ru                     | Piper, ru_RU-dmitri-medium          | CC0                                     |

The credit is shown under the words page's settings while the server voice
is on. For a Japanese kana reading the engine is given the written word
(行う, not おこなう) so it can pitch-accent it, but only when it reads the
word the way the list does; otherwise it gets the kana.

To render and upload (resumable, incremental):

```bash
bun scripts/voice/texts.ts > texts.jsonl
# VOICEVOX engine (github.com/VOICEVOX/voicevox_engine releases) running on :50021
uv venv -p 3.12 && uv pip install kokoro "misaki[zh,ja]" piper-tts soundfile lameenc
(cd ~/.cache/lianki-voice/piper && python -m piper.download_voices de_DE-thorsten-high ru_RU-dmitri-medium)
python scripts/voice/render.py texts.jsonl ~/.cache/lianki-voice/out [lang ...]
bun scripts/voice/upload.ts ~/.cache/lianki-voice/out
```

A Cloudflare API rate limit makes the upload ~4 clips/s, so a full upload
takes about four hours. A Whisper transcription of samples matched the text
for sentences in all seven languages; isolated single syllables are where
any voice is ambiguous.

## Prefetch and cost

`/words` fetches the audio of the rows on screen and up to two screens below,
plus the next five in queue order, before they are tapped
(`lib/words/audio-cache.ts`, an IntersectionObserver in `WordsClient.tsx`).
A tap reads three clips back to back, ~150 ms apart: the word, its meaning
(first sense, `lib/words/say-parts.ts`), and the example sentence. Each is its
own `/api/words/tts` URL in its own language. Prefetch order is all words
first, then examples, then meanings.

- **Limits.** 3 fetches at once, 300 clips per tab session, an in-memory LRU
  of 200 blob URLs (revoked on eviction), and nothing at all on Save-Data or
  2G. A 429 pauses prefetch for its Retry-After. A tap goes ahead of every
  prefetch. A text with no voice (404 `X-Voice: miss`, or 400) is remembered
  and goes straight to the browser's speech, for that part only.
- **HTTP cache.** Every 200 is `private, max-age=31536000, immutable`, so a
  device fetches a clip once a year at most. It stays `private`, not
  `public`, because the route is behind sign-in. No ETag is needed, since an
  immutable response is never revalidated.
- **Meaning voice.** `MEANING_VOICE` in `lib/words/say-parts.ts` is `"server"`
  until the owner decides (`"browser"` is free). Meanings are not
  pre-recorded, so a meaning's first request runs MeloTTS. After that it is
  an R2 hit for everyone, since the cache key holds no user. Latin-script
  meanings are read as English, because the bundled lists' glosses are
  English.

Cost, at list prices on 2026-10-29: MeloTTS $0.0002 / audio minute (18.63
neurons), R2 class B $0.36 / M (10 M free a month), class A $4.50 / M,
Workers $0.30 / M requests (10 M included).

| item | count | cost |
| --- | --- | --- |
| Meanings to generate, once ever | 19,440 distinct first senses in `public/words` (42,935 entries, avg 10.6 chars ≈ 1 s audio) | 324 min × $0.0002 = **$0.065** (≈ 6,000 neurons, under one day's free 10,000) |
| …their R2 writes | 19,440 class A | $0.087 once |
| …their storage | ~1.7 GB if 44.1 kHz WAV | ~$0.03 / month (10 GB free) |
| A recorded word or example | 1 Worker request + 1 class B | $0.00000066 |
| A cached meaning | 1 Worker request + 2 class B (voice miss, cache hit) | $0.00000102 |
| A session that hits the 300-clip cap | ≤ 300 requests + ≤ 600 class B | **≈ $0.0003** |

So the free tiers cover about 16,000 sessions a month at the cap. Real
sessions are smaller, and a device's HTTP cache serves repeat visits for
free. The one-time MeloTTS bill for every bundled meaning is under 7 cents.
Imported lists add their own meanings at about $0.31 per million characters (≈ 94,000 s of audio).
