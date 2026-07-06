# @lianki/ext

Browser extension targets for Lianki, built from **one source of truth** — the
existing Tampermonkey userscript (`src/lianki.user.ts`).

- **Userscript** (Tampermonkey/Violentmonkey): built by the root
  `build:userscript` script → `public/lianki.user.js`. Unchanged.
- **Chrome MV3 extension** (this package): `manifest.json` + a content script
  that runs the same userscript logic behind a GM→Chrome adapter.

```bash
bun --cwd packages/ext run build   # → dist/ (manifest.json + content.js)
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

## Status — scaffold (needs browser validation)

The build is green and produces a loadable extension, but it has **not** been
verified in a real Chrome yet. To validate: load `dist/` unpacked, sign in on
lianki.com, and confirm token storage (chrome.storage), card add/review
(GM_xmlhttpRequest → fetch), and the userscript UI all work. Likely follow-ups:
extension icons, an options/popup page, and possibly a background service worker
if any GM_xmlhttpRequest call needs to bypass page CSP.

## Roadmap — shared core

Codex's plan is to split the ~2000-line userscript into a shared behaviour core
(sync protocol, storage, API client) plus thin per-target adapters (GM vs
chrome.*). This package currently reuses the whole userscript as-is; the core
split is the next increment.
