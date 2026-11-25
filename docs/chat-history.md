# Chat history: the account keeps its chat

Owner request, 2026-11-07 20:38 JST: save the chat history (every lane's
lines in his thread) to the account, and a page to browse it: searchable, by
date, each line with its lane's name and mark.

Before this, the chat lived only in lianki-push's DebugHub storage: the last
`CHAT_HISTORY` (200) lines per thread, older ones dropped.

## What is kept

One D1 row per line of the user's **own** thread (`chat_line`,
`db/migrations/0057_chat_line.sql`):

| column          | what                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `user_id`       | the account; the owner's thread goes to each account holding `dev`, a Learning Partner thread to that user                     |
| `id`, `thread`  | the hub's line id; `owner` or the user's id                                                                                    |
| `sender`        | the line's `from`: owner, friend, agent                                                                                        |
| `lane`          | main, codex or agy on agent lines (`voices.ts` `laneOf`: the field, else the `【lane】` prefix, taken off the text; else main) |
| `text`, `at_ms` | the text as it reads now (after polish or a merge) and its time                                                                |
| `ask`, `answer` | 1 for an ask card; the chosen options' labels once tapped                                                                      |

**Never kept** (`lib/chat-log-line.ts` `chatLogLine` drops all of it): the
page context attached with the + menu (`context`) and a voice line's screen
text (`scene`) — page text, and on a private screen
(`[data-lk-private-screen]`: /vibe, a transcript in /reader) private speech,
which is not chat (docs/vibe.md); STT before polish (`raw`, `parts`); the page
label (path, user agent); avatars, emails; attachment ids (files stay in the
inbox); timings, speaker tags, wake modes. **Echoes** (his voice lines the hub
judged our own read-aloud heard back, [echo-suppression.md](echo-suppression.md))
are never lines at all, so never kept, until he taps "This was me". No audio and no clip ids are ever on
a line. Tested in `unit/chat-log.test.ts` and `unit/debug-hub.test.ts`
("chat history").

**On the device.** The last `chat.cacheLines` (default 40) lines of the
signed-in account's thread are also kept in the browser (`lk:chat-cache`,
`lib/chat-cache.ts`), so the chat paints at once on the next page load; the
hub's history replaces them when it arrives. The same never-kept list
applies there (`cacheLine`, an allowlist, tested in `unit/chat-cache.test.ts`),
and it also drops page labels and an answer's page label. One account per
device: another account's page, a page with no session, and sign-out drop it.
Sign-out also freezes the cache for the rest of the page (`freezeChatCache`):
the chat stays mounted through the sign-out request with a write timer
pending and the hub still sending, and none of that is written back; a
mounted chat whose account changes under it (the root layout's session
refresh) starts over for the new account (`lib/use-chat-cache.ts`, tested in
`unit/use-chat-cache.test.tsx`). docs/cold-start.md, "The chat at once".

## How it is written

```
page / lane ──▶ DebugHub.post ── sends to pages and listeners first
                  │ chatLogLine(m)            (lib/chat-log-line.ts, bundled into lianki-push)
                  ▼
                SESSIONS RPC  DebugSessions.chatLog   (worker.ts, 600/min per isolate)
                  │ chatLogOp                  (lib/chat-log.ts)
                  ▼
                D1 chat_line
```

- `put` (a new line): `INSERT OR IGNORE` — a replay never overwrites.
- `update` (a polish, a merged voice line, an ask's answer): only a row still
  kept. `split` (undo of a merge): the first part updates the line, the rest
  are added, only while the line is kept. So a deleted line stays deleted.
- `drop` (undo of a merged passage): deletes only the passage's own derived
  line, `<first id>.merged`, which the merge added with `put`; an id that is not
  such a derived line is refused, so a line he said is never dropped this way.
- The history never holds up or fails the chat: no binding, "busy" or an
  error is logged (`debug.chat-log`) and the line stays in the hub as ever.

**Backfill.** The owner's first visit to /chat/history (`GET
/api/chat/history`, owner session) asks lianki-push `POST
/internal/chat-backfill` over the PUSH binding; the hub sends its stored
owner-thread history through the same `chatLog` (`op: "backfill"`). Each owner
account is backfilled once (`chat_line_backfill`): a second call writes
nothing, so a line deleted since is not brought back. Learning Partner threads
are not backfilled.

## The page: /chat/history

Linked from the chat's + menu, View group, "History" (`onHistory`, DebugChat;
`chatHistory` string). Any signed-in user, their own account only.

- Newest first, grouped by the reader's local day (`longDate`, never a numeric
  date), sticky date headings; 100 lines a page, more as the end scrolls into
  view (IntersectionObserver; nothing polls).
- Search box (`q`, text `LIKE`, `%` and `_` literal) and lane chips (`lane`:
  you, main, codex, agy) are in the address (docs/ui-state.md: shareable).
- Each line: the lane's mark (`LaneMark.tsx` `laneAvatar`; main: the app's
  mark, as the chat), its name (main: the chat's own name), time, a Question
  tag on ask cards and "Answered: …". Agent rich text is shown plain.
- Delete a line (×) or a day (beside the date, when no search or filter is
  on): both confirm, and remove the rows from D1. The page says history
  follows the account.
- Strings: `app/(app)/chat/history/page.content.ts` (16 locales, a context
  line per key).

## Access

`lib/chat-history-api.ts`: every read and delete is by the session's user id;
nothing in a request names an account. No session: 404. A line of another
account answers 404, as one that does not exist.

**`lianki chat` tokens (#678).** A Bearer API token holding `chat:read`
reads its own account's history (`GET /api/chat/history`; the route's
`reader`, `checkToken(db, token, "chat:read")`); no backfill runs on a token's
read. Deleting stays with the session (and so does redacting a line
everywhere, below).

## Deleting a line (redact)

Owner request, 2026-11-25: a secret (a token link) pasted into his own
thread by mistake must leave his chat history. **Redact** takes one line back
everywhere it is kept; the line stays in its place (the thread still reads in
order) and reads the placeholder, "（已删除）" / "(deleted)" in each page's
language (`lineRedacted`, `packages/debug-chat/src/chat-ui-locales.ts`).
Stored, it is `REDACTED_TEXT` with the mark `redacted: {at}`
(`lib/chat-redact.ts`).

**What goes** (`redactMessage` keeps only who and when: id, from, label, time,
thread, sender, lane and token names, `collapsedInto`): the text, `raw`, the
edit mark, merged `parts`, `premerge`, `recheck`, attachments, audio, page
context and screen text, the ask and its answer, every voice field.

**Every copy the hub keeps** (`DebugHub.redact`, workers/push/src/debug.ts):

| copy                                   | what happens                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| DO storage ring (`msg:…`, `t:<id>:msg:…`) | the line is rewritten to a new key; the old key and value are deleted                                |
| lines merged or summarised into it     | redacted the same way (they keep `collapsedInto`, so they stay hidden)                                  |
| echoes kept aside (`echo:<id>`)        | any echo of it (`echo.of`, or the same words) is deleted, his pages hear `echo-gone`                    |
| D1 `chat_line`, every account          | `chatLog` op `redact`: text = placeholder, ask/answer cleared, for the id, `<id>.merged`, `<id>.summary`, members |
| Li's frozen window `ai:win:<thread>`   | each item holding its words (the line, an edit entry quoting it, an attributed copy) reads the placeholder; one prompt-cache miss |
| Li's pending reply (owner thread)      | dropped (`ownerAi.cancel`)                                                                              |
| open pages, listeners                  | `{type:"redacted", id, thread, seq, message}`: the line updates in place; the device cache (`lk:chat-cache`) follows |

Not reached: copies outside the hub — a lane's own logs on the Mac, a
`wrangler tail` that was open when the line was sent, and the voice
recordings on his Mac (`~/lianki-voice-clips`, never deleted without asking
him). A later polish, merge or summary never finds a redacted line
(`editable` skips it).

**Who may**: only the thread's own account, signed in on lianki.com.

- **His page**: the line's details (double tap, right-click) show
  "删除这条" / "Delete this line" on his own lines; a second, red
  "确认删除" / "Delete for everyone" deletes (`RedactRow`,
  `MessageDetails.tsx`). The page sends `{type:"redact", id}`; the hub takes
  it only from a full lianki.com page (cookie and origin checked in index.ts),
  never an embedded page (another site's frame) or a box, and in the owner
  thread only from a page carrying his sign-in session.
- **The session API**: `POST /api/chat/redact {id}` (`lib/chat-redact-api.ts`):
  a session, JSON, same origin; any `Authorization` header is refused, so no
  lane token, `lianki chat` / MCP token or eval token can delete. The thread
  is decided by the session (a `dev` holder: the dispatch thread; anyone else:
  their own), so another account's line answers 404. It reaches the hub as
  `POST /internal/chat-redact` over the PUSH binding.
- **His CLI**: `lianki-dev redact --id <id>` opens
  `https://lianki.com/chat/history?redact=<id>`, where his signed-in session
  shows the line and asks; his tap deletes. The command sends nothing itself
  and refuses `--as` / `LIANKI_LANE`.
- Never a controller (lane grant), never the token chat (`/api/version/chat`
  has no such op), never MCP.

**Audit**: one `security_audit` row per deletion, kind `chat.redact`: actor
the account id, subject the line id, detail `page|api thread=<thread>`, time
`at_ms`. Never the text. The hub logs `debug.redact` with the same, ids only.

Tested in `unit/chat-redact.test.ts`, `unit/chat-redact-row.test.tsx` and
`unit/debug-hub.test.ts` ("DebugHub redact").
