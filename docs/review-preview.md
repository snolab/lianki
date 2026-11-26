# Next-page previews on /review

While a page card is being reviewed, `/review` asks for only its immediate
successor in the existing due-card order. It can preload that webpage in a
restricted iframe below the review controls. Grading, scheduling, and opening
the full webpage in a new tab keep their existing behavior.

The warmed iframe stays mounted when its card becomes current. At most two
frames exist: that retained current page and one upcoming page. Earlier frames
are removed. This avoids reloading the retained preview; opening a separate
browser tab still depends on the site's cache rules and the browser's cache
partitioning. A preload is not a guarantee of instant external navigation.

## Configuration and traffic

- `review.nextPreview` (public, default on) enables the feature. Off uses the
  original next-card endpoint, with no preview check or iframe download.
- The browser's `navigator.connection.saveData` also disables preloading.
- `review.previewHeadTimeoutMs` (server, default 5000 ms) bounds the header/DNS
  check. The body is never downloaded by this check.
- `review.previewChecksPerMinute` (server, default 30 per account) bounds checks.
  A refused or exhausted check leaves a title and link; it never blocks grading.

## Embedding and authority

`GET /api/fsrs/next-preview?excludeUrl=…` selects the authenticated account's
next due card internally. It does not accept an arbitrary target URL. Its
response is private and not cached. A disabled feature or an empty queue makes
no outbound request.

Only public HTTPS pages on the default port are checked. IP literals, local
names, credential-bearing URLs, and Lianki's own pages are refused. DNS-over-HTTPS
uses the same public-address/CNAME checks as the BYOK relay; each redirect is
rechecked. As with that relay, Workers cannot pin the subsequent fetch to a
resolved address. Header requests use HEAD, omit credentials, and never forward
the incoming cookie or Authorization header. A HEAD refusal does not trigger a
second GET.

The iframe has an empty `sandbox`, no scripts, no same-origin permission,
no forms, popups, downloads, or top navigation. Its permissions policy denies
audio autoplay, microphone, camera, geolocation, payments, and fullscreen.
It sends no referrer. Script-dependent pages may have an incomplete preview;
the full webpage link is always available.

The server checks X-Frame-Options and enforced CSP frame-ancestors before
creating a frame. Unknown policies, refused embedding, non-HTML responses,
timeouts, or failed checks show the card's title and link instead. The parser
deliberately accepts only a small, recognizable subset of allowed CSP sources.
It never strips or bypasses a site's restrictions. The browser still enforces
the actual response policy. HEAD and a user's GET can differ, so a successful
header check is a hint, not proof that a cross-origin page rendered. Iframe
load/error events are not used to claim success; browsers can fire load even
when embedding was blocked.

## Verification

`unit/review-preview*.test.ts` covers policy classification, redirect and DNS
guards, credential-free requests, the authenticated next-card route, the
configuration switch, timeout, and rate limits. `unit/review-page-previews.test.tsx`
covers the actual component's retained frame, bounded lifecycle, disabled state,
and title/link fallback.

`bun scripts/qa/qa-review-previews.ts` uses controlled local pages in silent
Chromium. It verifies that promotion keeps the same browsing context and makes
one request per page, page scripts cannot execute, top navigation stays unchanged,
and known blocked fixtures never get an iframe GET. It uses the mandatory silent
instrumentation and is separate from production verification.
