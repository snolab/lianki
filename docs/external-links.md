# Links to other websites: the disclaimer

Owner request (2026-11-09 01:24 JST): before anyone leaves Lianki for another
website, a dialog says that the site is not affiliated with Lianki and that
Lianki is not responsible for its content. It is a disclaimer, worded with
each language's own idiom (the `disclaimer` key's context line says so).

## How a link is caught

One delegated handler, `app/components/ExternalLinkGuard.tsx`, mounted in the
root layout, so every page has it (landing, app pages, the partner frame). It
listens to `click` and `auxclick` on window in the **bubble** phase: a link a
component already handled (`preventDefault`) is left alone, and a link inside a
shadow root (the chat) is found through `composedPath()`. No per-link code.

- **Leaves**: an `http(s)` link to another host. Not: relative links, the
  page's own host (the dev origin, a box), `lianki.com` and every
  `*.lianki.com`, `mailto:`/`tel:`/`blob:`, downloads.
- **Opens** with `rel="noopener noreferrer"`: the guard adds both words to every
  leaving link it sees, asked about or not, and "Open site" follows a temporary
  link carrying them (`followLink`). A new tab (target, Cmd/Ctrl/Shift, middle
  click) stays a new tab.
- **Code that opens a site itself** calls `openExternal(href)` from
  `lib/external-link.ts` instead of `window.open`: the /review card's page, the
  AnkiWeb search on /words/import, a web result in the search palette.

The rules are pure, in `packages/core/src/externalLink.ts`
(`unit/external-link.test.ts`). QA: `scripts/qa/qa-external-link.mjs`
(qa:all's `external-link`).

## Chat link actions

Chat message links first show their own action menu (production too). Open
uses a temporary normal anchor outside the message tree, with no bypass
attribute, so this same delegated guard receives it. Copy and System menu
operate on the selected effective URL; the latter calls native share when
available, or offers a normal anchor for a long press. On preview, Lianki
links default to the current origin and also offer the production site;
external URLs are never rewritten and do not offer that extra action.
Normal page links continue to use the original direct-click behavior.

## The two bypasses (account settings)

| Box in the dialog            | Local key          | Server key           | Value                                 |
| ---------------------------- | ------------------ | -------------------- | ------------------------------------- |
| Don't ask again for any site | `lk:link-confirm`  | `links.confirm`      | `"0"` / `false`: never ask            |
| Don't ask again for this site | `lk:link-allowed` | `links.allowedHosts` | JSON list of hosts, newest last       |

Both are **synced** (docs/prefs-sync.md): written on the device, then pushed
with the account. An allowed host is kept without `www.` and covers its
subdomains (`wikipedia.org` covers `ja.wikipedia.org`; the dialog stores the
host it showed, so `en.wikipedia.org` covers only itself and below). Only a
public host can be kept: the schema refuses schemes, paths, IP addresses,
`.ts.net`, `.local` and bare names, and the dialog hides "this site" for a host
that could not be kept. The list keeps the newest 80, under the 2 KB value cap.

Settings → "Links to other sites" (`ExternalLinkSettings`) turns asking back on
and removes sites from the list.

Neither bypass is forever (owner, 2026-11-10): each asks again after a spaced
interval (7 days, then 30, 90, a year as it is ticked again), and a bypass that
came back and was not ticked again is dropped. See prefs-sync.md, "Don't ask
again" (`lib/dont-ask.ts`, the review list in Settings).

## Not covered, and why

- **The userscript and the extension.** They run on other sites' pages, and
  their links go to the user's own saved cards: the review flow moves from one
  card's site to the next, so a disclaimer there would interrupt every card,
  for sites the user chose. They also cannot read the account prefs yet (the
  userscript has no token path to `/api/prefs`; see prefs-sync.md,
  `script.heatmap`).
- **/next** (`NextCardClient`) sends the browser to the next card's page by
  itself, not from a link: it is that same review flow.
- **Sign-in, payments and Google connections** (OAuth providers, Stripe
  checkout) are redirects of our own flows, not links to another site.
- **The legacy HTML pages** generated in `app/fsrs.ts` are outside the React
  layout.
