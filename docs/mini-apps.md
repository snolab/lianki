# Mini apps: `/m/<slug>`

Owner, 2026-11-15 05:2x JST: a user's agent publishes a single-file HTML app;
it runs in a plain sandboxed iframe; through a frontend SDK it uses Lianki's
capabilities, each one a per-app permission the user grants in a prompt, "like
a browser opens each permission per site" (对每个页面分别开放各种权限一样).
Later notes the same morning: follow how Claude Artifacts are built, and give
real interactivity, not Artifacts' caution (我们要的是足够的可交互性). Mini apps are shipped behind the flag `mini-apps`. Browser publication needs
`dev`; an explicitly authorized agent can publish privately with its account token.

## What a mini app is

- **One HTML file** of at most config `miniApps.maxBytes` (default 2 MB, max
  16 MB as Artifacts), inline JS and CSS, plus pinned scripts from the CDN
  allowlist and Lianki's `/m/` files.
- **A manifest**: `slug` (lowercase ASCII and hyphens, 1–40; `sdk`,
  `presets`, `new`, `api`, `edit`, `settings` reserved), `name` (≤ 60),
  `icon` (one short glyph), `version` (`x.y.z`, shown, never compared) and
  `style`: `"lianki"` (default) or `"none"`, and `permissions`: the capabilities
  it may ask for (`lib/mini-apps/manifest.ts`).
  A method whose capability is not declared is refused without a prompt.
- **Stored**: R2 `lianki-blobs`, `mini-apps/<uid>/<slug>/index.html` and
  `manifest.json`; a D1 row per app in `mini_app` (migration
  `0078_mini_apps.sql`) for listing. Its random `id` (16 hex) is kept across
  republishes, so grants and storage survive a new version. At most
  `miniApps.perAccount` apps (20).
- **Private by default.** `/m/<slug>` is the signed-in account's own app;
  there is no way to open another account's. Sharing is phase 2.

`/m` is a short public noun (an app is a thing you visit, docs/url-principles.md
rule 1); it is a short form on purpose, like `/i`, because the address is
typed and spoken. The API keeps the long noun: `/api/my/mini-apps`.

## Isolation: never lianki.com's origin

The app must never run same-origin with lianki.com. Two modes, chosen by
config `miniApps.origin`:

1. **Its own origin (preferred)**: `miniApps.origin` = `https://m.lianki.com`,
   or one host per app `https://{app}.<another domain>`. The host page signs a
   10-minute ticket (HMAC with AUTH_SECRET: account, app id, file hash, host
   origin, `lib/mini-apps/ticket.ts`) and frames
   `<origin>/api/m/<slug>?t=…`. That route reads no session (the session
   cookie is `__Host-`, lianki.com only), checks the ticket and that the
   request's origin is exactly this app's, and answers the file with the CSP
   as a header, including `sandbox` and `frame-ancestors <host page>`.
   `middleware.ts` and `worker.ts` let a mini host serve only `/api/m/<slug>`,
   `/m/sdk.js` and `/m/presets/*`; `same-site-guard.ts` lets the ticketed GET
   through like an avatar read.
2. **srcdoc (the fallback, and the default while no host exists)**: the page
   embeds the file as `srcdoc` with the CSP as the first `<meta>`. An iframe
   sandboxed without `allow-same-origin` gets an **opaque origin**: no cookies,
   no `localStorage`, no access to the parent. Works today, with no DNS.

Both: `sandbox="allow-scripts allow-forms"`; `allow-same-origin` is added only
for a per-app origin on **another site** than lianki.com (`ownOriginAllowed`):
a `*.lianki.com` sibling could set cookies for lianki.com
(docs/security-measures.md, "Sibling hosts"), so `m.lianki.com` stays opaque
and apps there keep data with `lianki.storage`. Per-app browser storage, as
Artifacts have, needs a separate registrable domain.

The SDK and the CSP `<meta>` are inserted **before** the app's first byte
(after the doctype; `lib/mini-apps/html.ts`), so nothing of the app runs
ahead of them.

**The CSP** (`lib/mini-apps/csp.ts`): `default-src 'none'`; scripts inline,
`'unsafe-eval'` (in-browser JSX), Lianki's `/m/` and `miniApps.scriptOrigins`;
styles inline, `/m/` and `miniApps.styleOrigins` (Google Fonts); fonts from
`miniApps.fontOrigins` (`fonts.gstatic.com`); images and media `data:` /
`blob:` only; `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`,
`base-uri 'none'`. With no network at all, an app cannot send what it was
given anywhere; every capability goes through the host. Publishing also
checks every `<script src>` and stylesheet `<link>`: from the allowlist, and a
script pinned to an exact version (`react@18.3.1`, `three@0.160.0`).

### What the owner adds for mode 1 (approval needed)

- DNS: a proxied record `m.lianki.com` (covered by the zone's Universal SSL
  `*.lianki.com`), and a Worker route `m.lianki.com/*` → `lianki`.
- Then set `miniApps.origin` = `https://m.lianki.com` at /dev/config.
- For per-app origins: a separate registrable domain (e.g. a
  `liankiusercontent` domain) with a wildcard record, `*.<domain>/*` → `lianki`,
  `{app}` in the template; `isMiniHost` in `lib/mini-apps/origin.ts` names it.
  A second-level wildcard under lianki.com (`*.m.lianki.com`) would need
  Advanced Certificate Manager and is still a sibling, so it is not the plan.
- Locally, `http://m.localhost:3000` works as mode 1 without DNS.

## Modelled on Claude Artifacts

| Artifacts                                                      | Lianki mini apps                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| page on a separate origin, sandboxed iframe, strict CSP        | `m.lianki.com` / per-app origin (mode 1) or opaque `srcdoc` (mode 2), sandbox, CSP above             |
| scripts only from cdnjs, jsdelivr/npm, unpkg, tailwind, jquery | the same list, config `miniApps.scriptOrigins`; exact versions checked at publish                    |
| stylesheets only from Google Fonts; everything else inline     | `miniApps.styleOrigins` / `fontOrigins`, plus Lianki's own `/m/presets/`                             |
| capabilities declared up front                                 | manifest `permissions`                                                                               |
| `window.<host>.*` runtime over postMessage, gated per page     | `window.lianki.*` (`/m/sdk.js`) → host bridge, gated per (account, app, capability) by a prompt card |
| browser storage per artifact origin                            | per-app origin on another site: yes; otherwise `lianki.storage` (D1, per app)                        |
| 16 MB cap                                                      | `miniApps.maxBytes`, default 2 MB, max 16 MB                                                         |
| private by default, explicit sharing                           | the owner's own only (phase 1); sharing in phase 2                                                   |

Where we differ on purpose: real capabilities from the first slice (the
user's chat, settings, cards answered by a tap), because the point is
interactivity.

## The SDK: `window.lianki`

`/m/sdk.js` is inserted into every app. Each call is a `postMessage` to the
host (`{lk: "mini/1", id, method, args}` → `{lk, id, ok, result | error}`);
the host (`lib/mini-apps/bridge.ts`) accepts only messages whose source is its
own iframe's window and whose origin is the app's (`"null"` for srcdoc), asks
the user when needed, and calls `POST /api/my/mini-apps/<slug>` `{action:
"call"}`, where the server checks the grant again.

| method                                                       | capability    |
| ------------------------------------------------------------ | ------------- |
| `lianki.storage.get(key)` / `.set(key, value)` / `.list()`   | `storage`     |
| `lianki.prefs.get(keys?)`                                    | `prefs:read`  |
| `lianki.prefs.set(key, value)`                               | `prefs:write` |
| `lianki.chat.read(limit)`                                    | `chat:read`   |
| `lianki.chat.say(text)`                                      | `chat:write`  |
| `lianki.ui.card({title, options})` → the tapped label / null | `chat:ask`    |

Also `lianki.manifest()` and `lianki.request(permission)` (asks up front:
`granted | denied | prompt | undeclared`). A refusal rejects with an `Error`
whose `.code` is the reason (`permission-denied`, `storage-full`…).

- **storage**: per-app JSON values in D1 `mini_app_kv`, keys
  `[A-Za-z0-9_.:-]{1,128}`, at most `miniApps.storageBytes` per app (256 KB).
- **prefs**: only the keys in `miniApps.prefKeys` that exist in
  `lib/prefs/schema.ts` (language, paper, motion, text size, preferred
  languages, read-aloud, voice rate); each value checked by its schema and
  written as a synced pref (HLC device `app<id>`). Never BYOK, links, titles,
  "don't ask" or mail.
- **chat**: the account's own thread only. Read is the D1 chat history; say
  and card mint a 15-minute API token of the account's own, named
  `app-<slug>` with exactly that chat permission, call lianki-push's token
  chat over the PUSH binding, and revoke it at once. The line reads
  【app-slug】, never as the user. A card waits on a token socket for the tap
  (no polling), at most `miniApps.cardWaitMs` (2 min), then answers `null`.

Later capabilities (voice, cards in messages, cross-app messages) are a row in
`lib/mini-apps/capabilities.ts`, a case in `handlers.ts` and a prompt line.

## Permissions

The first use of a capability shows a card over the app: "<app> wants to:
<what>", **Allow this time / Allow for this app / Don't allow** (strings and
context lines in `app/(app)/m/mini-app.content.ts`, 16 locales). Stored per
(account, app, capability) in `mini_app_grant`: `allow` and `deny` stay until
the user removes them in **/my/preferences → Mini apps**; `once` is spent by
the next call. Escape closes the card: that call fails, the next one asks
again. Prompts are queued one at a time.

## Who can publish

- **Browser session**: accounts holding `dev`, same-origin JSON POST to
  `/api/my/mini-apps` with `{manifest, html}`. Local development can also use
  `bun scripts/dev/mini-app-publish.ts` with local D1/R2.
- **Account token / MCP**: the same POST accepts Bearer authentication with
  **both `apps:publish` and `chat:write` on that token**. `apps:publish` is
  absent from the default chat-only preset. If missing, request it through
  the existing individual token-scope approval page; only the signed-in token
  owner can approve. Publication never grants the mini app any runtime capability.
  Expiry, revocation, account ownership, feature gate, quotas, body-size limits,
  HTML checks and R2 account prefixes still apply. Invalid Bearer authentication
  never falls back to a browser session.

```bash
lianki app publish --manifest ./manifest.json --html ./index.html --json
# MCP: lianki_app_publish {manifest: {...}, html: "<!doctype html>..."}
```

Publishing returns the private app URL `/m/<slug>`; it does not automatically
post a message or expose an app publicly. Installed CLI versions need a release
before the new command is available.

## Referencing an app in chat

A participant can include a relative `/m/<slug>` link (or its canonical/dev-site
absolute URL) in a message. Alternatively, an agent can send
`{op:"say",text:"Try this",attachments:[{type:"app",slug:"calculator"}]}`.
The CLI supports `lianki chat say "Try this" --app calculator`; MCP
`lianki_chat_say` accepts the same app attachments. References carry only a
validated slug, never HTML; a normal link is also preserved in the text so
minimal long-term chat history retains it. Arbitrary external links are never
turned into executable cards.

The bubble shows the app's title, icon and **Open** button. Metadata is loaded
from the signed-in account's own app; another account's same slug is never
looked up. Open presents a panel over the chat with a pointer/keyboard height
handle, fullscreen panel toggle and close button. The panel always uses opaque
`srcdoc` with `sandbox="allow-scripts allow-forms"`, including when standalone
apps use an independent origin. No `allow-same-origin`, parent HTML injection or
automatic browser fullscreen call is introduced. The existing capability bridge
and **Allow this time / Allow for this app / Don't allow** prompts remain in use.
The host is lazy-loaded only when the card is opened.

Chat panel sizes follow public config `miniApps.chatHeightPx`,
`miniApps.chatMinHeightPx`, and `miniApps.chatResizeStepPx`; actual bounds follow
the visual viewport. The view endpoint is session-only
`GET /api/my/mini-apps/<slug>?embed=1`; Bearer publishing does not grant access to
browser-session capability prompts or another account's app.

## Recommended styling, optional per app

The manifest accepts `style: "lianki" | "none"`. Omitting it keeps the
recommended Lianki style pack, including for apps published before this option
existed. Publishing through `POST /api/my/mini-apps` validates the field:
other values are rejected, and the selected value remains in the stored manifest.
Migration `0081_mini_app_style.sql` adds the D1 column with a `lianki` default;
apply it before serving code that reads the new column. It does not rewrite app
HTML or remove any existing app styles.

Set `"style": "none"` to use browser defaults or the app's own styles. Lianki
then skips automatic inline style-pack injection; the sandbox, CSP, SDK and
capability prompts are unchanged. An app may still explicitly include its own
CSS or opt into an allowed stylesheet. Theme information remains available for
apps that choose to follow it. The SDK exposes the current choice as
`lianki.style`, as well as the manifest's `style` field.

A minimal native-styled example is `/m/presets/unstyled.html`, paired with
`/m/presets/unstyled.manifest.json`; it is listed under `examples.none` in
`/m/presets/presets.json`. To publish it locally:

```bash
bun scripts/dev/mini-app-publish.ts public/m/presets/unstyled.html public/m/presets/unstyled.manifest.json
```

## Style pack and presets

`<link rel="stylesheet" href="/m/presets/lianki.css">` is a small version of
Lianki's own CSS: the oklch tokens of app/globals.css (seal-ink red primary,
paper and ink, gold, surfaces, lines), the fonts (LXGW WenKai TC, Klee One from
Google Fonts), light and dark, base typography, and plain `button`, `input`,
`select`, `textarea`, `a`, `table` styled like the app with no class needed;
`button.primary` / `.secondary` / `.ghost`, `.card`, `.pill` (`.on`),
`.segmented` (every state shown, the current one seal red) and the
`.lk-app .lk-card .lk-btn .lk-btn-primary .lk-input .lk-row .lk-stack .lk-mono
.lk-seal` helpers. No hex or rgb: oklch only (checked in a unit test).

**With `style: "lianki"` (the default), the pack is inlined** (`lib/mini-apps/style-pack.ts`, kept
equal to the public file by a test) as a `<style>` before the app, and the
app's own `<link>` to it is dropped: a srcdoc app has no origin, and a link
would depend on the page's host matching the CSP's (it did not on the preview,
2026-11-15: the calculator rendered unstyled). Other `/m/presets/*` references
are rewritten to Lianki's absolute origin, which the CSP allows. Its own
origin (mode 1) gets the same inlined copy.

**Night mode follows the site**: the host page bakes its theme into the frame
as `<html data-theme="light|dark">` before the app loads, and when the system
theme changes it posts `{lk: "mini/1", event: "theme"}`, which the SDK applies.
With no `data-theme`, the pack falls back to `prefers-color-scheme`.

The recommended pack exposes variables for apps that want to match the site;
apps may instead use their own styling. `/m/presets/presets.json` lists the pinned presets:

```html
<script src="/m/presets/chart.js"></script>
<!-- lkChart.bar(el, data), lkChart.line(el, data): SVG in the pack's tokens -->
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
<!-- <script type="text/babel"> -->
<script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js" } }
</script>
<script type="module">
  import * as THREE from "three"; /* a WebGL scene */
</script>
```

The sample, a calculator using storage (history), `chat.say` and `ui.card`,
is `scripts/dev/mini-apps/calculator.html`.

## Abuse and review notes

- No network, no cookies, no top navigation (no `allow-top-navigation`), no
  popups, no modals; camera, mic and location blocked by Permissions-Policy
  in mode 1. Only the owner sees their own app.
- Calls rate-limited per account (`miniApps.callsPerMinute`, per isolate);
  publish too. Sizes, slug and manifest checked on the server.
- Delete: `DELETE /api/my/mini-apps/<slug>` removes the files, the row, the
  grants and the storage.
- Logs carry the slug and size, never the file.

## Config and flag

| key                       | default                              |
| ------------------------- | ------------------------------------ |
| flag `mini-apps`          | on (audience owner; publish = `dev`) |
| `miniApps.maxBytes`       | 2 MB                                 |
| `miniApps.storageBytes`   | 256 KB per app                       |
| `miniApps.perAccount`     | 20                                   |
| `miniApps.callsPerMinute` | 120                                  |
| `miniApps.cardWaitMs`     | 120 000                              |
| `miniApps.origin`         | "" (srcdoc)                          |
| `miniApps.scriptOrigins`  | the Artifacts CDN list               |
| `miniApps.styleOrigins`   | `https://fonts.googleapis.com`       |
| `miniApps.fontOrigins`    | `https://fonts.gstatic.com`          |
| `miniApps.prefKeys`       | the seven keys above                 |

Code: `lib/mini-apps/*`, `app/(app)/m/[slug]/`, `app/api/my/mini-apps/**`,
`app/api/m/[slug]/`, `public/m/`; tests `unit/mini-apps-*.test.ts`.
