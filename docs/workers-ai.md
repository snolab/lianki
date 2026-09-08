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
