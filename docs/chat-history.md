# Chat history: the account keeps its chat

Owner request, 2026-11-07 20:38 JST: save the chat history (every lane's
lines in his thread) to the account, and a page to browse it: searchable, by
date, each line with its lane's name and mark.

Before this, the chat lived only in lianki-push's DebugHub storage: the last
`CHAT_HISTORY` (200) lines per thread, older ones dropped.

## What is kept

One D1 row per line of the user's **own** thread (`chat_line`,
`db/migrations/0057_chat_line.sql`):

| column | what |
| --- | --- |
| `user_id` | the account; the owner's thread goes to each active owner (`site_role`), a Learning Partner thread to that user |
| `id`, `thread` | the hub's line id; `owner` or the user's id |
| `sender` | the line's `from`: owner, friend, agent |
| `lane` | main, codex or agy on agent lines (`voices.ts` `laneOf`: the field, else the `【lane】` prefix, taken off the text; else main) |
| `text`, `at_ms` | the text as it reads now (after polish or a merge) and its time |
| `ask`, `answer` | 1 for an ask card; the chosen options' labels once tapped |

**Never kept** (`lib/chat-log-line.ts` `chatLogLine` drops all of it): the
page context attached with the + menu (`context`) and a voice line's screen
text (`scene`) — page text, and on a private screen
(`[data-lk-private-screen]`: /vibe, a transcript in /read) private speech,
which is not chat (docs/vibe.md); STT before polish (`raw`, `parts`); the page
label (path, user agent); avatars, emails; attachment ids (files stay in the
inbox); timings, speaker tags, wake modes. No audio and no clip ids are ever on
a line. Tested in `unit/chat-log.test.ts` and `unit/debug-hub.test.ts`
("chat history").

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
read. Deleting stays with the session.
