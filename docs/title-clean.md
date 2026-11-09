# Cleaning notification prefixes out of page titles

Owner, 2026-11-06 00:15 JST: page titles carry unread counts that change on
every visit, like "(99+ 封私信 / 38 条消息) 怎么能让书里的信息成为自己的知识呢？ - 知乎".
They are taken off when a title is saved and when a card is shown. The patterns
are editable at `/my/preferences` → Page titles and follow the account.

The code is `packages/core/src/titleClean.ts`, one generic matcher with the rules
as data. Tests and the corpus are in `unit/title-clean.test.ts`.

## How a number is known to be a counter

A title alone cannot say: "(3) YouTube" is a count, "(1984) film review" is not.
There are three kinds of evidence, and a bare number needs one of the last two.

1. **The shape says so, on any site.** A number with the word for what it counts
   ("(3 messages)", "(38 条消息)"), or a capped badge of all nines ("(99+)").
   "(18+)" is an age rating and stays.
2. **The site is known to do it.** `youtube.com`, `x.com`, `facebook.com` and
   others have a rule for a bare count of 1 or 2 digits, so "(2024) …" and
   "(100) …" stay there too.
3. **The same page was seen with another number.** When a card is saved again,
   a title differing from the stored one only by its number proves a counter
   (`dropCountSeenChanging`). It needs a stored title, so it runs on the server
   at save time and never at display.

## What remains ambiguous

- A real "(1) Intro - YouTube", or "(12) Songs / X", on a site with a count rule
  loses its number. At display that is reversible (the stored title is untouched);
  at capture the number is not stored. The user can remove the rule.
- "(18+) Foo / X" on `x.com`, `twitter.com` and `facebook.com` loses its rating:
  those sites do cap their badge at a round number, so `(#+)` is on them.
- "(3) Foo" on a site with no rule is left as it is, even when it is a count,
  until the page is saved again with another number.
- A yearly page whose title moves from "(2024) Foo" to "(2025) Foo" under one url,
  saved again, is treated as a counter by the third kind of evidence.
- "Inbox (3) - Gmail" has its count in the middle. Only prefixes are handled.

## The pattern syntax, and why it is not a regex

Rules arrive from synced preferences and run on every page the userscript runs
on, third-party sites included. They are untrusted input, and JavaScript regex
has no timeout, so a `(a+)+$` would hang the tab. **No RegExp is ever built from a
rule.** A pattern compiles to a short token list and the matcher walks it forwards
once, with no backtracking:

| Token   | Matches                                                                  |
| ------- | ------------------------------------------------------------------------ |
| `#`     | a number of 1 or 2 digits, and no more                                   |
| `##`    | a number of up to 4 digits, which may end in `+`                         |
| `*`     | short text up to the literal after it, never past a closing bracket      |
| a space | any spacing, or none                                                     |
| `\x`    | the character `x` itself                                                 |
| other   | itself, ignoring case and full-width forms (`(` also matches `（`)       |

A pattern only matches at the start of a title. It cannot begin or end with `*`,
and a `*` must have literal text after it, which is what makes it one scan.

The cost is bounded by construction: at most 48 characters a pattern, 3 `*` each
reaching 64 characters, 128 rules, 3 stacked prefixes, and only the first 512
characters of a title are looked at. A rule that does not compile is skipped.

A title that would be left with no letter or number stays exactly as it was.

## What is stored

`titles.rules` (`lk:title-rules`, docs/prefs-sync.md) holds a difference from the
defaults, `{ off: [default rule ids], add: [{ host, pattern }] }`: someone who
never edits keeps getting the defaults as they improve, and it fits the 2 KB a
preference may hold. So at most 10 patterns of your own. "Restore defaults" brings
back the removed built-ins and keeps your own.

The userscript and the extension have no path to `/api/prefs`, so
`GET /api/preferences` also answers `titleRules`, and they read it through the
`lk:preferences` cache like the other preferences (up to an hour old). They coerce
it again on arrival: the cache is not trusted either.

The `workers/edge` spike's copy of that route (local only, no production route)
does not answer `titleRules`. Porting the route has to add it, or the userscript
silently falls back to the defaults.

## Where it applies

**Capture:** the userscript and the extension (`pageTitle()`, which share one
source), and the server's `saveNote`, which every way of saving goes through, so an
old userscript or a bookmarklet is cleaned too. Watch-time titles are cleaned by
the client only.

**Display:** `displayTitle(title, url)` from `lib/titles/client.ts` (/list for guests, /data, /stats, search, /review and its next-up strip via `lib/review-title.ts`), synchronous,
reading the device's copy of the preference; `cleanTitle` with
`titleRulesForUser()` on the server. Display never writes. Exports and the title
editor on `/data` show the stored title.

**Stored titles are not rewritten.** Existing cards keep theirs. Saving a page again
does store the cleaned title, because saving has always replaced it.

**Dedup is unaffected:** cards are unique by `(email, url)`, and no title is used to
match cards. `/data`'s search and sort, and the server's `LIKE` search, still use the
stored title.
