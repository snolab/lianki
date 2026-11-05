# Your own AI (BYOK)

Owner request, 2026-11-05 14:22–14:27 JST. A user brings their own AI
provider, backend and API key, set in **Settings** (`/preferences`, section
「自己的 AI」), not `/connections`. By default the browser calls the provider
directly with the user's key. For an **allowlisted** provider the user may
instead tick 「经 Lianki 转发（不保存）」: then the call goes through Lianki's
stateless relay (`POST /api/byok/proxy`, "The relay" below), which forwards it
and forgets the key and the text (owner, Slack 2026-11-05 15:27 JST "ab
together"; allowlist only, 15:35 JST). The **managed** mode (the server
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
| the relay (server)              | `app/api/byok/proxy/route.ts`, `lib/byok/proxy-server.ts`, guards in `lib/byok/proxy-guard.ts` |
| the relay's allowlist (data)    | `relay: {host, paths}` on a preset in `lib/byok/presets.ts`     |
| tests                           | `unit/byok.test.ts`, `unit/byok-proxy.test.ts`                  |

## What is kept, where

| Key               | Holds                                                          | Class                                  |
| ----------------- | -------------------------------------------------------------- | -------------------------------------- |
| `lk:byok`         | `{v, mode: "device", enabled, backend, apiKey}`                 | **device only, never synced**          |
| `lk:byok-ack`     | `{v: <notice version>, at}`: the privacy notice was acknowledged | device only                            |
| `lk:byok-backend` | `{provider, baseUrl, model, relay?}` or `null`                  | **synced** as `byok.backend`, opt-in   |

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

With 「经 Lianki 转发」 on, both go through the relay instead; nothing else
changes (still no charge, still nothing written).

There is no AI word split or sense pick on the client today; when one is
added, it takes the same path. Server-side features — Learning Partner
replies, the background gloss fill (制卡, the word review), polish — keep
using our backend and credits, and the settings text says so. **The relay
does not change that**: it only carries the browser's own calls; no
server-side feature is switched to a user's key.

## The relay (`POST /api/byok/proxy`)

Stateless: the browser sends the key in `Authorization: Bearer …` and
`{provider, baseUrl, model, messages, maxTokens, temperature?}` as JSON; the
server builds the provider request from those fields only, forwards it,
streams the answer back, and forgets both. Nothing is stored, cached or
charged; no account is needed (a session, if any, only gets its own rate
counter, and is read from the cookie alone so the key never reaches session
lookup).

**Allowlist, not an open proxy** (owner, 15:35 JST: "we should make a allow
list, or we will be dangerously open proxy"). The relay forwards only to a
preset with `relay: {host, paths}` in `lib/byok/presets.ts`:

| preset     | host                                | path(s)                                   |
| ---------- | ----------------------------------- | ----------------------------------------- |
| openai     | `api.openai.com`                    | `/v1/chat/completions`                    |
| anthropic  | `api.anthropic.com`                 | `/v1/messages`                            |
| deepseek   | `api.deepseek.com`                  | `/chat/completions`, `/v1/chat/completions` |
| gemini     | `generativelanguage.googleapis.com` | `/v1beta/openai/chat/completions`         |
| openrouter | `openrouter.ai`                     | `/api/v1/chat/completions`                |

Custom and Ollama are never relayed: custom backends stay browser-direct
only, and the toggle is drawn only for an allowlisted preset. Adding a host is
an **owner action**: a reviewed PR adding `relay` to a preset (chosen over a
D1 table at /dev — simpler, versioned, reviewed; users can never add one).

Guards (each tested in `unit/byok-proxy.test.ts`):

- **Request**: POST, same-origin JSON only (`sameOriginJson`); body ≤ 64 KiB
  (declared and counted while streaming); strict fields — unknown fields,
  tools, other roles, > 40 messages, > 48 000 characters, maxTokens outside
  1–4096 are refused; the key only from `Authorization` (printable ASCII,
  ≤ 512).
- **Target**: exactly the preset's host, `https`, port 443, exactly an
  allowed path, method POST; no `user:pass@`, query, fragment, `%`-encoding
  or backslash; never an IP literal in any spelling (decimal `2130706433`,
  octal, hex, short `127.1`, IPv6, IPv4-mapped), never `*.lianki.com`,
  `*.workers.dev` (our Workers), `localhost`, `.internal` /
  `metadata.google.internal`, `.local`, `.home.arpa`… (all of those are also
  off the allowlist; the extra rules are defence in depth).
- **DNS**: before each hop the host is resolved over DoH
  (`cloudflare-dns.com`, A and AAAA) and accepted only if it has addresses
  and every one is public: private, loopback, link-local (incl.
  169.254.169.254), CGNAT, multicast, unspecified, documentation/reserved,
  unique-local (incl. `fd00:ec2::254`), IPv4-mapped/-compatible, NAT64,
  6to4 and Teredo are refused, as is a CNAME into ours or a local name.
  Fails closed. An accepted host is remembered 60 s (the name only).
- **Redirects**: `redirect: "manual"`; only 307/308 (they keep POST), at most
  3 hops, each re-checked against the same preset's allowlist and resolved
  again; a hop to another host is refused, so the key only goes where the
  user chose.
- **Answer**: 30 s for the whole call; only `application/json`; streamed
  through, cut off (error) past 1 MiB; a provider error returns only
  `{proxyError: "auth" | "http", status}` — never its body, which can echo
  the key. Responses carry `cache-control: no-store, private`.
- **Rate limits**: per IP 40/min, per signed-in user 60/min, the whole relay
  1000/min (D1 `auth_throttle` counters in production, in memory in dev; the
  keys are `byok-proxy:{global,ip:<ip>,user:<id>}`, never anything of the
  request). A failing counter refuses (fails closed).
- **Logging**: one line per call: `{event: "byok.proxy", provider, outcome,
  status, ms, hops, bytes}`. Never the key, a header, the URL, a body or the
  provider's message (a test spies on every console method).

**Residual risks.**

- *DNS rebinding / pinning.* A Worker's `fetch()` resolves the name itself and
  offers no way to pin the address we checked, so its resolution may differ
  from our DoH check. Mitigations: the allowlist (a few
  providers' own hostnames, not attacker-chosen names), the DoH check before
  every hop, https with the provider's certificate (a rebind to another
  address fails TLS for that name), and Cloudflare's egress itself, which has
  no route to private networks or a cloud metadata service.
- *In transit.* Our server sees the key and text while it forwards them;
  "not stored, not logged" is our code's promise, which the notice and
  `/privacy#own-ai` state plainly. Cloudflare's own request metadata records
  the request but not its body. Checked 2026-11-05 with `wrangler tail lianki
  --format json` and a throwaway random value: `Authorization` and
  `x-byok-key` arrive as `REDACTED`, an ordinary `x-lk-plain` in clear, so the
  key's header is not readable in tail events (what `lianki-monitor` gets).
  **Keep the key in `Authorization`**: a custom header name without `key`,
  `auth` or the like could be logged in clear. Not checked: the Workers Logs
  dashboard store, which wrangler cannot query.
- *Abuse with stolen keys.* The relay could launder calls made with someone
  else's key; the per-IP/user/global limits and the size caps bound it.

The client: `relayRequest` / `relayComplete` in `lib/byok/call.ts`
(`backend.relay`); the settings show the toggle only when the preset has
`relay`, explain that the key passes through in transit and is not stored
(`relayHint`, `keyHereRelay`), and after a failed browser-direct Test of an
allowlisted preset (`cors` / `opaque-auth`) suggest the relay with a
「开启转发并重试」 button. The notice gained a fifth point about it
(`noticeRelay`), so `BYOK_NOTICE_VERSION` is 2.

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
  can never reach our server by what is typed here (only the relay's own
  toggle sends it to us, in transit, for an allowlisted provider);
- no `user:password@`, query or fragment.

If a CSP is added later, its `connect-src` needs the preset hosts plus
`http://localhost:* http://127.0.0.1:*`, and custom hosts can then only be
allowed by `https:` (the client rule stays the gate).

## Never leaving the device (audit, 2026-11-05)

This holds for browser-direct calls, and for everything below except the one
relayed request when the user ticks the relay ("The relay").

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
