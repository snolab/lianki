# @lianki/ext

## ⚠️ Data collection — read before any Chrome Web Store submission

The content script matches `*://*/*` and, since the watch-time feature, records
**per-video viewing behaviour**. The store listing and privacy policy must say so
before this ships; the previous disclosure predates this and is now incomplete.

**What is recorded**, keyed by normalized URL, for every `<video>`/`<audio>` the
user plays:

| field | meaning |
| --- | --- |
| `wall` | active wall-clock seconds — only while playing, audible, visible, non-ad |
| `media` | seconds of content consumed (differs from `wall` at non-1× speed) |
| `sessions` | count of distinct viewing sessions |
| `days` | local-calendar-day → seconds, for streaks and the heatmap |
| `cov` | bitset of which 5-second segments were reached |
| `dur`, `lang` | media duration and detected audio language |
| `first`, `last` | first and most recent activity timestamps |
| page title | sent alongside, to label the video |

**Where it goes:** `GM_setValue`/`chrome.storage.local` first (offline-first), then
synced to the user's own Lianki account at `www.lianki.com` (or `beta.`). Nothing
is sent anywhere else, and nothing is sent for a signed-out user.

**Scope caveat:** because `@match` is `*://*/*`, this applies to media on *any*
site the user visits, not only YouTube. Time is counted only while a media
element is actually playing — page visits alone record nothing — but the
permission surface is every site, and the disclosure has to reflect that.

**Retention:** rows live until the user deletes the note. Locally, an LRU keeps at
most 500 per-URL caches (`lianki_devbundle_*`/`lk:watch:*`).

**Opting out:** `WATCH_REQUIRE_VISIBLE` / `WATCH_REQUIRE_AUDIBLE` in
`src/lianki.user.ts` gate what counts; there is currently **no user-facing toggle
to disable watch tracking entirely** — worth adding before a store release.


## Chrome Web Store submission

Build the upload package with the pipeline, never by hand:

```bash
bun scripts/build-extension.ts          # -> packages/ext/dist/lianki-extension.zip
```

It generates the icons, builds `content.js`, derives the manifest version from
`lib/userscript-version.ts`, and zips the result. The version is *derived* because
it had silently drifted seven patches behind the product (2.23.17 vs 2.24.1); a
number nobody owns is a number nobody updates.

### Privacy policy

<https://lianki.com/privacy> — required by the store for any extension handling
user data. Keep it truthful as data flows change; it is written from the code, not
from intent.

### Permission justifications (paste into the listing)

**`storage`**

> Cards, review history and settings are written to local extension storage first,
> so scheduling works offline and without an account. Nothing else is kept here.

**Host permission `*://*/*` (content script)**

> Lianki is a spaced-repetition tool for whatever the user is already reading or
> watching. The user decides, on any site, that the current page should become a
> flashcard — so the script must be able to run wherever they are, in the same way
> a bookmarking extension must. It cannot be narrowed to a list of sites without
> removing the feature.
>
> The script does not transmit the pages a user visits. A page leaves the device
> only after the user explicitly adds it as a card, or when they play video/audio
> on it and watch-time is recorded for their own study statistics. Ordinary
> browsing is never sent anywhere, and for a signed-out user nothing leaves the
> browser at all.

**Host permissions `https://lianki.com/*`, `https://www.lianki.com/*`, `https://beta.lianki.com/*`**

> Sync the user's own cards to their own Lianki account. These are the only remote
> hosts the extension contacts.

### Remaining manual steps

The Web Store console cannot be automated — Chrome blocks devtools-driven
navigation to `chrome.google.com/webstore/devconsole` and
`chromewebstore.google.com/devconsole` outright. Creating the item, uploading the
zip, filling the listing and publishing are all manual.

Still needed in the listing itself: screenshots (1280×800 or 640×400), a category,
and the data-usage disclosures matching the privacy policy above.

Browser extension targets for Lianki, built from **one source of truth** — the
existing Tampermonkey userscript (`src/lianki.user.ts`).

- **Userscript** (Tampermonkey/Violentmonkey): built by the root
  `build:userscript` script → `public/lianki.user.js`. Unchanged.
- **Chrome MV3 extension** (this package): `manifest.json` + a content script
  that runs the same userscript logic behind a GM→Chrome adapter.

```bash
bun run --filter='@lianki/ext' build   # → dist/ (manifest.json + content.js)
# Load unpacked: chrome://extensions → Developer mode → Load unpacked → dist/
```

## How the MV3 target works

The userscript relies on GM APIs absent from an MV3 content script. `src/gm-shim.ts`
adapts them:

| GM API | MV3 adapter |
| --- | --- |
| `GM_getValue` / `GM_setValue` / `GM_deleteValue` | `chrome.storage.local` (prefixed `gm:`) |
| `GM_xmlhttpRequest` | `fetch` (cross-origin allowed by `host_permissions`) |
| `GM_info` | static version/name |

**Critical detail:** `GM_getValue` is *synchronous* but `chrome.storage` is
async. `src/content.ts` preloads the store into a sync cache (`loadGmCache`)
**before** dynamically importing the userscript, so `GM_getValue` reads
synchronously from the cache.

## Testing

Two layers, both automated:

- **Unit (no browser, CI):** `unit/gm-shim.test.ts` mocks `chrome.storage` +
  `fetch` and asserts the adapter — sync `GM_getValue` from the preloaded cache,
  write-through, delete, and `GM_xmlhttpRequest`→fetch onload/onerror. Runs with
  `bun run test:unit`.
- **Integration (real Chromium):** `tests/extension.spec.ts` builds `dist/`,
  loads it unpacked into Chromium via Playwright, navigates to a matched page,
  and asserts the content script ran (it stamps `<html data-lianki-ext="loaded">`).
  Run it with:

  ```bash
  bun run test:ext           # builds + xvfb-run playwright (headless needs a display)
  ```

Still worth a manual pass before shipping: sign in on lianki.com and confirm
token storage, card add/review, and the userscript UI in a real profile. Likely
follow-ups: extension icons and an options/popup page.

## Roadmap — shared core

Codex's plan is to split the ~2000-line userscript into a shared behaviour core
(sync protocol, storage, API client) plus thin per-target adapters (GM vs
chrome.*). This package currently reuses the whole userscript as-is; the core
split is the next increment.
