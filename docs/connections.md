# Connections (Google Drive)

A **connection** lets Lianki open files a user chooses in another service.
The first one is Google Drive, for importing the user's own **private Google
Docs** into /reader. Approved by the owner 2026-11-04 (Slack, ~16:20 JST).

It is **separate from sign-in**. Signing in with Google is better-auth's
`account` row with `openid email profile`; a connection is its own row in its
own table, from its own OAuth flow. Disconnecting never signs anyone out, and
signing out or unlinking the sign-in never touches a connection.

Ships **dark**: flag `connections.google` (off) — while off, only the owner
(`isDev`) sees /connections and the Drive import; everyone else gets 404. Turn it on at `/dev/flags` once the setup below is done and checked.

## Flow

1. **/connections** (signed in) shows Google Drive: status, account email,
   granted access, Connect / Disconnect. Also linked from /my/profile.
2. **Connect** → `POST /api/connections/google/start` (same-origin JSON,
   10 per user per 10 min). The server makes a random `state` and a PKCE
   verifier (S256), seals both with the user id and a 10-minute expiry into
   an HttpOnly cookie `lk_gconn` (path `/api/connections/google`,
   SameSite=Lax), and answers Google's consent URL:
   scopes `openid email https://www.googleapis.com/auth/drive.file`,
   `access_type=offline`, `prompt=consent` (a refresh token every time), never
   `include_granted_scopes` (see `lib/google-auth-url.ts`: the shared GCP
   project would fold unrelated scopes in and Google refuses the request).
3. Google → **`GET /api/connections/google/callback`**. The cookie must open,
   belong to the signed-in user, be unexpired, and its state must equal
   Google's (constant time). The code is exchanged with the verifier; the
   id token's `iss`/`aud`/`exp` are checked (it comes straight from Google's
   token endpoint, so no signature check is needed, OIDC Core 3.1.3.7); the
   refresh token is sealed into D1. Every outcome redirects to our own page
   with a fixed word (`?google=connected|denied|failed|bad-state|…`).
4. **Disconnect** → `POST /api/connections/google/disconnect`: revoke at
   `oauth2.googleapis.com/revoke` (best effort), delete the row regardless.

### Importing a private doc (/reader)

`drive.file` reaches only files the user opened with Lianki **through the
Google Picker**, so:

1. The user pastes a docs.google.com link in the /reader Google Docs import
   (the public-link import, `app/api/read/gdoc`, #513). When the public
   export answers `not-shared`, the page offers **Choose in Google Drive**
   (`app/(app)/reader/GdocDriveImport.tsx`).
2. That calls `POST /api/connections/google/picker` (30 per user per 10 min):
   a short-lived `drive.file` access token, the Picker's browser key and the
   project number. Not connected (409): to Google's consent first, back to
   `/reader?gdoc=<id>`, where the import reopens on that doc.
3. The Picker (`lib/connections/picker-client.ts`, loaded on demand from
   apis.google.com) opens **preselected on that doc** (`DocsView.setFileIds`);
   picking it grants `drive.file` on exactly that file.
4. `POST /api/read/gdoc {url, via: "drive"}`: the server gets the user's
   access token (memory, else refresh), reads `files.get` (must be a Google
   Docs document) and `files.export?mimeType=text/html` from
   `www.googleapis.com/drive/v3/files/<id>` (`lib/gdoc/drive.ts`), then imports
   exactly as the public path does: same parser, same `source_key`
   `gdoc:<id>` dedupe, re-import updates the book in place.

### Picking docs ("Choose docs from Google Drive")

Owner, option A, 2026-11-05 10:50 JST: after connecting, /connections must
lead somewhere. The connected card and /reader's import row both carry
**Choose docs from Google Drive** (`app/(app)/connections/DrivePick.tsx`,
flow in `lib/connections/drive-pick.ts`), with a three-step how-to under it:

1. It opens the Picker at once (no link), **multi-select**
   (`Feature.MULTISELECT_ENABLED`, `pickGoogleDocs`).
2. Each picked doc goes through the same `POST /api/read/gdoc {via: "drive"}`
   as above, one after the other (so `source_key gdoc:<id>`, a re-import
   updates the book). One imported → it opens in /reader; several → the page
   says how many and its list reloads (/connections: `router.refresh()`;
   /reader: the materials list).
3. Not connected, or the grant ended (409): Google's consent with
   `return` `/connections?pick=drive` or `/reader?pick=drive` (`returnPath`
   allows exactly these). Back with `?pick=drive&google=connected`, the
   Picker opens by itself (`autoPickOnReturn`), and both words leave the URL.
   A denial or failure never opens it.

### Imported docs (/connections)

Under the button, **Docs imported from Google**: the user's books whose
`source_key` is `gdoc:<id>` (`lib/connections/gdoc-imports.ts`, a range on
the `(user_id, source_key)` index, newest `updated_at` first, ≤ 200), each
with title, last sync (relative, the user's locale), Open, and **Sync again**
(`resyncGdoc`): through Drive first; a doc that came by its public link was
never picked, so Drive refuses it (`not-granted`) and the public link is
used. Either way it is the same import, so `carrySentenceCards` moves the
sentence cards of unchanged lines to the new text. A title the user set
with Rename (the /reader row's ⋯ menu, `PATCH /api/read/<id>`) is kept:
`read_materials.title_custom` (migration 0038) stops a re-import from
replacing it, while the text still updates. The list also shows,
read-only apart from Sync, while the connection is off but books exist.

QA mocks the Picker (`window.gapi` / `google.picker` stubbed, the picker
and import routes answered): `scripts/qa/qa-drive-pick.mjs`.

### Picker guards

Owner, iPhone PWA, 2026-11-10 22:35 JST: the first open of the Picker on
/reader showed Google's "The API developer key is invalid."; closing it and
opening again worked. The key itself is fine (the second open uses the same
one). Not reproduced locally — the page is Google's — so the opens are
guarded instead:

- **Setup checked first** (`lib/connections/picker-setup.ts`,
  `parsePickerSetup`): the token, key and app id must have their shapes (the
  same regexes as the server's `pickerConfig`) before the Picker is built.
  An error body, a non-JSON answer or an empty field never reaches Google.
- **Built only when ready** (`picker-client.ts`, `loadPicker`): only from
  `gapi.load("picker")`'s callback with a usable namespace (a
  `PickerBuilder`), one api.js tag even when two opens race, a 20 s load
  timeout, and only while the page is visible (on the way back from consent
  it may still be hidden).
- **One retry** (`pickWithRetry`): a malformed setup, a Picker that did not
  load, or one that reports `Action.ERROR` is tried once more with a fresh
  `POST …/picker`. Never a third time; any other failure is not retried.

Unit tests: `unit/picker-guard.test.ts`. If the message comes back and the
Picker sends no `Action.ERROR` for it, the retry cannot see it: the next
lead is the key's referrer restriction and the iframe's referrer in WebKit.

## Live stream (a Google Docs tab → /reader)

Owner, 2026-11-06: a doc edited during a meeting shows up in the reader as it
is written, its words matched against his decks. The Docs page is already
live, so the userscript uses it: no Drive grant, no webhook, no server polling.
Flag `read.gdoc-stream` (off: the owner only).

1. On a docs.google.com document the userscript asks
   `GET /api/read/gdoc/stream`; a 200 shows its **Stream to Lianki** switch.
   **Nothing is sent until the user turns it on for that doc**
   (`lk:gdoc-stream:<id>`, per doc, kept across reloads).
2. **Live edits** go straight to the reader. The Docs page receives each edit
   on Google's own channel (its `/bind` stream): `{"ty":"is","ibi":<index>,"s":
   "<text>"}` inserts, `{"ty":"ds","si":…,"ei":…}` deletes. `src/gdoc-stream.ts`
   sees them as the page reads `responseText` (the reason for `@grant
   unsafeWindow`), and posts `{book, ops}`, which only passes through lianki-push
   to the user's own open readers and is stored nowhere. Measured 2026-11-06:
   about 120 ms from Google to the Mac. **Undocumented format**: if it changes,
   nothing arrives here and only saves (3) update the reader.
3. **Saving** uses the export, after a pause in the edits (and again once when
   the export should have caught up): it lagged the page by 1.6 to 5.4 s in
   testing, which is why it is not the live path. Canvas `fillText` also asks for
   a save, since it is how typing in the same tab is seen (that tab's own edits
   are not on its channel). `POST /api/read/gdoc/stream {docId, html, title}`
   stores it as any Docs import (`lib/read/gdoc-store.ts`: same `gdoc:<id>` book;
   cards of unchanged lines carried; a polish dropped). `DOMParser` is unavailable
   on Docs (Trusted Types); an answer under half the previous size is believed
   only when it repeats.
4. **The reader** (`/reader/<id>?streamingFrom=google-docs`, `reader-stream.tsx`)
   treats the doc as **append only** (`lib/read/gdoc-tail.ts`): edits at the end
   grow a tail under the book, revisions inside the tail apply, anything earlier
   waits for the next save. Only new words are cut, looked up and flashed. On a
   save it fetches the book, keeps its place, and the tail keeps only what the
   book does not hold yet. It opens at the end (a deep link still wins; ordinary
   books keep their place); scrolling up stops the following. The tail has the book's selection rules
   (`lib/read/tail-select.ts`): tap, combo, a hand selection grown to whole
   sentences, stitched translation; a word's meaning and card need it in the
   book, so a tap on one written since the last save saves first. With nothing
   selected, the card follows the newest whole sentences, and the unfinished one
   once the text rests (`latestPlan`). Each is translated once, through the same
   metered translate route (a higher per-user limit for who may read a live doc,
   60 per 10 min was used up within minutes); a hidden tab does not follow; its ×
   stops following for that visit.

The raw-transcript offer (`lib/read/polish-offer.ts`) never shows on this page
(owner, 2026-11-06: "when we are still in meeting"). The socket's states are the
reader's, not the writer's, and the writer sends no end, so "ended" means the
doc was opened without `?streamingFrom`; a socket gone offline has not ended.
The tidy action stays in the contents sheet; the next save drops a polish (3).

Limits: it runs only while the doc is open in a tab with the userscript, so the
writer's side is desktop only (the reader can be any device). Word marks in the
tail are learning or not recognised; "new" needs the save.

/vibe transcripts ([vibe.md](vibe.md)) use the same reader stream at
`?streamingFrom=vibe`: saves only, without `LiveTail`, so nothing is translated by itself.

## Polish (a live doc as a speech draft)

Owner, 2026-11-06: fillers out, professional speech draft level, incrementally,
and (same day) never shorter by leaving things out: the first version polished only
the last 1500 characters and the new text, so the draft held 2,361 of 59,194
characters. Now the whole doc, in order. `POST /api/read/[id]/polish-live {passages,
before?}` (`lib/read/live-polish.ts`) takes whole sentences grouped into passages,
because a doc's paragraphs can run to 17,000 characters, and answers one edit per
passage by its number. A passage with no answer, cut off or grown by half comes back
null, and one under half its length comes back `thin`: the reader flags both and keeps
the original. It rewrites, so unlike the transcript polish it has no word check. It
stores nothing: the raw text stays the book's, and nothing goes back to the doc. The
polish may write a word no save of the book holds, so `gloss` and `make-cards` take
`draft: true`: for who may polish, one word at a time, 120 per 10 minutes (`draftOwn`).

Where: the second choice of 整理 in the reader's contents sheet
(`reader-draft.tsx`, over the book, tab memory only, so not saved). Its words take
the live tail's tap, combo and slider (`draft: true`).

Model: DeepSeek V4.1 Flash on Workers AI, the owner's choice (`READ_POLISH_MODEL`
overrides), $0.30 / M in, $1.20 / M out on 2026-11-06. Estimate, not measured: about
$0.03 an hour of text (18,000 characters an hour, 36 calls). Paid by the Cloudflare account: `chargeAi`
only logs today, no user credits are taken. Flag `read.live-polish`, off: the
owner only.

## Tokens at rest

| what                  | where                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| refresh token         | D1 `connection.refresh_enc`, AES-256-GCM sealed                            |
| access token (≤ 1 h)  | the Worker isolate's memory; the browser's memory while the Picker is open |
| state + PKCE verifier | the sealed `lk_gconn` cookie, 10 min                                       |

- **Key**: HKDF-SHA256 from `AUTH_SECRET`, one key per purpose (`info`
  `lianki/connections/<purpose>/v1`), so no new Worker secret. AAD binds each
  sealed value to its user (and provider), so a value copied to another row
  or cookie does not open. Rotating `AUTH_SECRET` makes stored grants
  unreadable: those connections show "connect again" and nothing else breaks.
- A refused refresh (`invalid_grant`: the user removed Lianki at
  myaccount.google.com) marks the row `reconnect`.
- Tokens, codes and the cookie are never logged; a failed callback logs
  `connections.google.callback-failed` with the user id, a step word
  (`consent`, `code`, `token`, `id-token`, `no-refresh-token`, else
  `exchange-or-save` plus the error's class name), the HTTP status and
  Google's `error` word (e.g. `invalid_grant`) only. Google's error text is
  never shown, echoed or logged.
- Calls to Google use `redirect: "manual"`, never `"error"`: the Workers
  runtime throws a TypeError on `"error"`, which made every connect fail
  until 2026-11-05.

## Tables

`db/migrations/0034_connection.sql` — `connection` (PK `user_id, provider`):
`account_sub`, `account_email`, `scopes` (space-separated, as granted),
`refresh_enc`, `status` (`ok` | `reconnect`), `created_ms`, `updated_ms`.
`ON DELETE CASCADE` from `user`. Rate limits use `auth_throttle`
(`lib/security/throttle.ts`).

## Code

| piece                          | where                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| flow, storage, refresh, revoke | `lib/connections/google.ts`                                              |
| sealing                        | `lib/connections/crypto.ts`                                              |
| gate (`connectionsOn`)         | `lib/connections/gate.ts`, route gate `lib/connections/route.ts`         |
| routes                         | `app/api/connections/google/{start,callback,picker,disconnect}`          |
| page                           | `app/(app)/connections/`                                                 |
| Drive export                   | `lib/gdoc/drive.ts`; import in `app/api/read/gdoc/route.ts`              |
| Picker                         | `lib/connections/picker-client.ts`, `app/(app)/reader/GdocDriveImport.tsx` |
| pick button, imported list     | `app/(app)/connections/{DrivePick,GdocImportList}.tsx`                   |
| their logic                    | `lib/connections/{drive-pick,gdoc-imports}.ts`                           |
| tests                          | `unit/connections.test.ts`, `unit/drive-pick.test.ts`                    |

## Owner setup (Google Cloud console, project of the sign-in client)

Until these are done, /connections says "not available yet" and the Drive
button says the same; nothing else is affected.

1. **APIs & Services → Library**: enable **Google Drive API** and **Google
   Picker API** (the Google Docs API is not used: the export is Drive's).
2. **Google Auth Platform → Data Access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/drive.file` (non-sensitive, no
   verification), Save.
3. **Google Auth Platform → Clients →** the web client whose id is
   `AUTH_GOOGLE_ID` **→ Authorized redirect URIs → Add URI**:
   `https://lianki.com/api/connections/google/callback`, Save. (Local dev,
   optional: `http://localhost:3000/api/connections/google/callback`.)
4. **APIs & Services → Credentials → Create credentials → API key**; edit it:
   Application restrictions **Websites** `https://lianki.com/*`, API
   restrictions **Google Picker API** only. Then
   `bunx wrangler secret put GOOGLE_PICKER_API_KEY` and paste it at the
   prompt (it is a browser key, but keep it out of chat and code anyway).
5. **Project number** (the Picker's app id): **IAM & Admin → Settings**. It
   is normally the numeric prefix of `AUTH_GOOGLE_ID`, which the code uses by
   default; only if it differs, `bunx wrangler secret put GOOGLE_PICKER_APP_ID`.
6. If the consent screen's **Audience** is "Testing", the account must be a
   listed test user (or publish the app; `drive.file` needs no review).

Then on lianki.com (owner): /connections → Connect → /reader → paste a private
doc's link → Choose in Google Drive. When it works, `connections.google` on
at `/dev/flags` opens it to everyone.
