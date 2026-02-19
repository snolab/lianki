---
title: "The Lianki Userscript: Browser Integration with Tampermonkey"
date: 2025-02-10
tags: [userscript, tampermonkey, violentmonkey, browser]
summary: "How the Lianki Tampermonkey userscript works: the floating button, inline review dialog, URL normalization, and mobile quirks."
---

# The Lianki Userscript: Browser Integration with Tampermonkey

The core of Lianki's UX is a Tampermonkey/Violentmonkey userscript (`lianki.user.js`). It puts a floating button on every page you visit. One shortcut adds the current page to your review queue. Reviews happen inline, without leaving the page.

## Installation

Install from: `https://www.lianki.com/lianki.user.js`

The script runs on `https://*/*` — every HTTPS page. It injects a draggable floating action button (FAB) in the bottom-right corner.

## The Floating Button

The FAB is a circle that persists across pages. Its position is saved with `GM_setValue` so it stays where you dragged it last:

```javascript
GM_setValue("fabPosition", JSON.stringify({ x, y }));
// ...on load:
const pos = JSON.parse(GM_getValue("fabPosition", "{}"));
```

Dragging uses `pointermove`/`pointerup` events. If the pointer moves less than 5px total, the event is treated as a click (not a drag). This threshold prevents accidental opens when dragging.

## Adding a Card

Press `Alt+F` or click the FAB to open the add dialog. The dialog shows the current page URL (already normalized) and title. Submitting calls:

```
GET /api/fsrs/add?url=<normalized_url>&title=<title>
```

The script uses `GM_xmlhttpRequest` instead of `fetch`. This is necessary because `fetch` with `include` credentials can behave inconsistently on mobile browsers when handling `set-cookie` response headers. `GM_xmlhttpRequest` bypasses the page's CSP and always includes cookies correctly.

```javascript
function gmFetch(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url,
      withCredentials: true,
      onload: resolve,
      onerror: reject,
    });
  });
}
```

## The Review Dialog

When a card is due and you're on its URL, the FAB glows. Clicking opens the review dialog with four buttons showing the next interval for each rating:

```
Again  →  1d
Hard   →  3d
Good   →  8d
Easy   →  3w
```

Keyboard shortcuts work during review:
- `1` / `D` / `L` — Again
- `2` / `W` / `K` — Hard
- `3` / `S` / `J` — Good
- `4` / `A` / `H` — Easy

The shortcuts cover both WASD and HJKL layouts, plus the numpad 1–4, so whatever your muscle memory is, it works.

After rating, the API redirects to the next due card or returns `{"done": true}`. The dialog shows a success message and closes, optionally following the redirect automatically.

## Dialog States

The dialog is a simple state machine:

| State | What's shown |
|-------|-------------|
| `idle` | Nothing |
| `adding` | Spinner, "Adding…" |
| `reviewing` | Four rating buttons with due dates |
| `reviewed` | "Done!" message, auto-close countdown |
| `error` | Error message with login/retry link |

Error detection is JSON-based: if the API returns `{"error": "not authenticated"}`, the dialog shows a login link. This avoids trying to parse HTML error pages.

## URL Normalization

Before any URL is sent to the server, the script normalizes it client-side:

```javascript
function normalizeUrl(raw) {
  const url = new URL(raw);

  // YouTube short links
  if (url.hostname === "youtu.be") {
    return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  }

  // Mobile subdomains
  if (/^m\./.test(url.hostname)) {
    url.hostname = "www." + url.hostname.slice(2);
  }

  // Strip tracking parameters
  ["utm_source", "utm_medium", "utm_campaign", "utm_term",
   "utm_content", "fbclid", "gclid", "ref", "_ga",
   /* ... and more */ ].forEach(p => url.searchParams.delete(p));

  return url.toString();
}
```

The server runs the same normalization on ingest. Running it client-side too means the URL shown in the dialog is already the canonical form, so users see what will actually be stored.

## App-Hijacking Protection on Mobile

Some mobile apps register themselves as URL handlers for their domain. On Android, opening a zhihu.com link in a browser triggers a prompt to open the Zhihu app instead. If Lianki auto-navigated to a Zhihu URL for review, it would hijack the user's browser with an app-open dialog.

The script has a blocklist of known hijacking domains:

```javascript
const APP_HIJACKING_DOMAINS = ["zhihu.com", /* ... */];

function wouldHijack(url) {
  const { hostname } = new URL(url);
  return APP_HIJACKING_DOMAINS.some(d => hostname.endsWith(d));
}
```

Cards from these domains are still reviewed, but the auto-redirect behavior is suppressed on mobile. The user sees the review buttons without being auto-forwarded to the page.

## Auto-Update

The script checks for updates automatically. Every API response from `lianki.com` includes an `x-lianki-version` header. If the version doesn't match the script's current version, the update dialog appears:

```javascript
const serverVersion = response.responseHeaders
  .match(/x-lianki-version: (.+)/)?.[1];
if (serverVersion && serverVersion !== GM_info.script.version) {
  showUpdateDialog(serverVersion);
}
```

This avoids relying on Tampermonkey's built-in update check schedule, which can be slow.

## Why a Userscript and Not a Browser Extension

Extensions require separate review and publication for each browser (Chrome Web Store, Firefox Add-ons, etc.). Userscripts work across all browsers that support Tampermonkey or Violentmonkey, which covers Chrome, Firefox, Safari (via Userscripts app), and Edge. Updating an extension goes through a review queue. Updating a userscript is just pushing a new file to the same URL — Tampermonkey checks for updates automatically.

The tradeoff is that the userscript requires users to already have Tampermonkey installed. For the target audience (developers and power users), this is rarely a barrier.
