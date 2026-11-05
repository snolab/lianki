# Your own AI (BYOK)

Owner request, 2026-11-05 14:22–14:27 JST. A user brings their own AI
provider, backend and API key, set in **Settings** (`/preferences`, section
「自己的 AI」), not `/connections`. v1 is **browser-only**: the browser calls
the provider directly with the user's key. The **managed** mode (the server
keeps the key, encrypted, so server-side features can use it) waits for the
owner's tap card on the storage design; nothing of it is built except a
disabled checkbox behind the flag `byok.sync`.

| piece                           | where                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| presets (data)                  | `lib/byok/presets.ts`                                           |
| storage, URL rules, the notice  | `lib/byok/config.ts`                                            |
| the call, errors, Test          | `lib/byok/call.ts`                                              |
| settings UI, strings            | `app/components/ByokSettings.tsx`, `byok-settings.content.ts`   |
| reader translation              | `app/(app)/read/[id]/use-select-translate.ts`                   |
| reader word meaning (gloss)     | `app/(app)/read/[id]/use-select-gloss.ts`, `/api/read/[id]/gloss` (`own: true`) |
| sync of the backend             | `byok.backend` in `lib/prefs/schema.ts` / `bindings.ts`         |
| tests                           | `unit/byok.test.ts`                                             |

## What is kept, where

| Key               | Holds                                                          | Class                                  |
| ----------------- | -------------------------------------------------------------- | -------------------------------------- |
| `lk:byok`         | `{v, mode: "device", enabled, backend, apiKey}`                 | **device only, never synced**          |
| `lk:byok-ack`     | `{v: <notice version>, at}`: the privacy notice was acknowledged | device only                            |
| `lk:byok-backend` | `{provider, baseUrl, model}` or `null`                          | **synced** as `byok.backend`, opt-in   |

- The **backend** (`ByokBackend`: provider, base URL, model) is not secret and
  is the one shape both modes share. When the user ticks 「同步到我的账号」
  it is written to `lk:byok-backend` and follows the account through
  prefs-sync; unticking writes `null`. The server stores it and never fetches
  it. A synced backend wins over the device's own. Syncing needs a (free)
  account: guests see the checkbox disabled with 「登录免费账号即可同步」.
- The **API key** is only in `lk:byok`. "Remove from this device" deletes the
  whole record. It is not a prefs-sync binding, so it can never be sent
  (`unit/byok.test.ts` checks no binding reads it, and no pref key is named
  like a key or token).
- Guests: `/preferences` shows only this section to a visitor who is not
  signed in (the rest needs `/api/preferences`). The reader itself needs an
  account today, so a guest's setting waits until they sign in.

## The privacy notice

BYOK means Lianki cannot promise privacy. A short notice is always shown by
the switch; the full one opens the first time the switch is turned on and
the switch stays off until 「我明白」 (`withEnabled` refuses without it;
`activeByok` ignores a record without it). It says: what is sent (the text of
each request — the selected text, sentence, paragraph or words — plus the
instructions), that it goes directly from the browser to the chosen provider
or backend, that Lianki does not control how that provider stores or uses it
(link to the preset's policy), and that a custom backend sees everything.
The answer is stored with `BYOK_NOTICE_VERSION`; bump it when the notice's
meaning changes and everyone is asked again. `/privacy#own-ai` has the same
points.

## What uses it

Only what can run from the browser:

- **Selection-card translation** (/read): each unit goes to the provider;
  `/api/read/[id]/translate` is not called, so nothing is charged and
  nothing is written to `read_translation`. Results stay in the tab's cache
  under `own:` keys.
- **A word's meaning on the selection card**: the gloss route is asked with
  `own: true`, which runs the decks and the shared `word_gloss` rows only
  (no model, no charge) and returns `ask: {lang, term}` when they have
  nothing; the browser asks the provider for that headword. The answer stays
  in the tab, never in `word_gloss`.
- Both show 「用你自己的 key」 on the result.

There is no AI word split or sense pick on the client today; when one is
added, it takes the same path. Server-side features — Learning Partner
replies, the background gloss fill (制卡, the word review), polish — keep
using our backend and credits, and the settings text says so.

## Presets and the browser

Checked 2026-11-05 from `Origin: https://lianki.com` with a throwaway invalid
key (no real key used): a 401/400 that carries `Access-Control-Allow-Origin`
means a page may call it.

| preset     | endpoint                                                  | browser | note                                                                 |
| ---------- | --------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| OpenAI     | `https://api.openai.com/v1/chat/completions`              | yes     | preflight allows; a 401 comes **without** CORS headers, so a bad key reads as a network error (`opaque-auth`: "check the key") |
| Anthropic  | `https://api.anthropic.com/v1/messages`                   | yes     | needs `anthropic-dangerous-direct-browser-access: true`; ACAO `*`    |
| DeepSeek   | `https://api.deepseek.com/chat/completions`               | yes     | ACAO echoes the origin                                               |
| Gemini     | `…/v1beta/openai/chat/completions` (OpenAI-compatible)    | yes     | preflight refuses unknown headers: send only authorization + content-type |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions`           | yes     | ACAO `*`                                                             |
| Ollama     | `http://localhost:11434/v1/chat/completions`              | yes     | needs `OLLAMA_ORIGINS=https://lianki.com`; Safari blocks http://localhost from https |
| Custom     | `<base>/chat/completions`, OpenAI-compatible              | depends | must send CORS headers itself; "Test" explains a CORS failure        |

A preset that turns out to have no CORS gets `browser: false` and is shown as
unusable in browser mode (`gapOf` → "server-only"); none does today.

## URLs and CSP

**The app sets no Content-Security-Policy** (only `frame-ancestors *` on
`/embed/partner`, `next.config.mjs`; docs/monitoring.md), so `connect-src`
does not block these calls and there was nothing to widen. Adding a site-wide
CSP just for this would break the debug hub, tunnels and live view, so it was
not done. The rule is enforced in code instead, by `checkBaseUrl`, before
saving and again right before every fetch:

- `https://` to any host, or `http://` to `localhost`, `127.0.0.1`, `[::1]`
  only (mixed content: browsers treat those as secure; anything else over
  http is refused);
- never a Lianki host (`*.lianki.com`) or the page's own origin, so the key
  can never be sent to our server, whatever is typed;
- no `user:password@`, query or fragment.

If a CSP is added later, its `connect-src` needs the preset hosts plus
`http://localhost:* http://127.0.0.1:*`, and custom hosts can then only be
allowed by `https:` (the client rule stays the gate).

## Never leaving the device (audit, 2026-11-05)

- **Calls**: `credentials: "omit"`, `referrerPolicy: "no-referrer"`; errors
  carry only a kind and an HTTP status, never the provider's message (OpenAI's
  echoes part of the key). Nothing in `lib/byok` logs.
- **Prefs sync**: registry-based; `lk:byok` and `lk:byok-ack` have no binding.
- **Debug widget / page errors** (`packages/debug-chat/src/page-errors.ts`):
  only same-origin `/api/*` responses are hooked, so provider calls are never
  reported; typed text in open inputs is cut out of what is sent; the screen
  text (`scene.ts`) reads text nodes, never input values, so the key field
  (a password field by default) is not in it.
- **Li chat context / Learning Partner**: sends the user's messages and study
  summary, never localStorage; nothing reads `lk:byok`.
- **Analytics**: the app has none client-side.
- The key input has `spellCheck={false}` (Chrome's enhanced spell check would
  send it to Google) and password-manager opt-outs.
- The owner's own debug eval (`scripts/dev/eval.ts`) can read anything on his
  own page by design; it is his device.
