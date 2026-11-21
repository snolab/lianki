# Bombadil: random exploration of the local app

[Bombadil](https://github.com/antithesishq/bombadil) (Antithesis) drives a
Chromium with random clicks, keys, scrolls and navigation, and checks
LTL-style properties on every state it captures. It finds what example-based
suites miss: a page nobody scripted, an order of actions nobody tried.

It is local only and isolated: its own Worker on a loopback port, an empty
local D1, a throwaway account, a browser that can resolve no host but
localhost, and the silent-QA layer. It never touches lianki.com, production D1
or a shared dev server.

## Run it

```bash
bun scripts/qa/bombadil.ts                     # 3 minutes (default)
bun scripts/qa/bombadil.ts --time 10m          # s / m / h
bun scripts/qa/bombadil.ts --exit-on-violation # stop at the first one
bun scripts/qa/bombadil.ts --build             # rebuild .open-next first
BOMBADIL_VERBOSE=1 bun scripts/qa/bombadil.ts  # show wrangler's and the build's output
```

Exit codes: `0` clean, `2` a property was violated (Bombadil's own code), `3`
a navigation tried to leave localhost or a page was not silent, `1` anything
else (no binary, the build or server failed).

Options: `--port` (Worker, default 3210), `--cdp-port` (default 9333), `--out

<dir>` (default `tmp/bombadil/<timestamp>`, gitignored), `--base
http://localhost:N` to point at a server you started yourself. With `--base`,
the database is yours to vouch for: only a server on a local, throwaway DB.
Never the owner's `:3000` / `:3100` servers (those may be on production D1).

Prereqs: the `bombadil` binary (below), Playwright's Chromium
(`bunx playwright install chromium`), and a worktree with no `.dev.vars` and
no `.env*` file. The runner never reads those files: if one exists, it refuses
to start its own server (it could hold a real secret or a remote DB) and asks
for a clean worktree (`git worktree add <dir> origin/main`). A missing or
broken binary fails at once (exit 1), before any server starts.

### Install the binary

From the official release, pinned to v0.7.10 (checked by sha256):

```bash
gh release download v0.7.10 -R antithesishq/bombadil -p bombadil-aarch64-darwin
shasum -a 256 bombadil-aarch64-darwin   # 3d7866e2e8356390a0f2560853e3c775839f8c8ff648c9552c0105f7f78d1d72
install -m 755 bombadil-aarch64-darwin ~/.local/bin/bombadil
```

The runner looks in `$BOMBADIL_BIN`, `~/.local/bin/bombadil`, then `PATH`.
On Linux take `bombadil-x86_64-linux` / `bombadil-aarch64-linux`.

### Read the results

The run prints each violated property with the values that broke it, then a
summary per property. `bombadil browser inspect <out-dir>` opens the trace
(screenshots, each state's cells, the actions) in a browser; it serves the
trace locally and plays nothing. The run also prints a `--reproduce` command
for the same action sequence.

## What the runner does

1. **Server**: the deployed path, as `qa:all` runs it: the OpenNext Worker
   (`.open-next`, built with `CF_BUILD=1 DB_BACKEND=d1` if missing) under
   `wrangler dev --local` (remote bindings off) on `127.0.0.1:3210`. D1
   migrations go into a fresh temp dir (`--persist-to`), so each run starts
   from an empty database and `.wrangler/state` is never touched. Vars are
   passed with `--var`; `.dev.vars` is not written. Every child gets an
   environment built from scratch: no Cloudflare token, no mail key, no
   secret from the shell.
2. **Browser**: Playwright's Chromium through `launchPersistentSilent`
   (`scripts/qa/silent.mjs`), the same layer as every QA suite: headless,
   `--mute-audio`, `--use-fake-device-for-media-stream`, plus
   `--use-fake-ui-for-media-stream`, and the init script that keeps media
   muted, routes Web Audio to a zero gain and stubs `speechSynthesis`. Remote
   debugging listens on `127.0.0.1` only, for Bombadil to attach to.
3. **Network boundary**, two layers: `--host-resolver-rules` maps every host
   but `localhost` / `127.0.0.1` to nothing, and a request filter aborts any
   request to another host (counted in the summary; a main-frame navigation
   off localhost fails the run with exit 3). `/api/words/tts` is answered with
   a silent stub, as in `qa-words`.
4. **Silence proved before the first action**: the tab Bombadil drives, and a
   tab opened over raw CDP (as Bombadil could), must show muted media and the
   stubbed `play`, Web Audio and `speechSynthesis`. Any page opened later is
   checked as it loads; a loud one stops the run (exit 3).
5. **Account**: signs up `qa+bombadil<time>@lianki.test` on the local Worker,
   adds the first catalog list from `/words/index.json`, and opens
   `/words?list=<id>` in the tab.
6. `bombadil browser test-external --allow-url http://localhost:3210/*
--time-limit …` against that tab, with `qa/bombadil/spec.ts`, at 390×844.
7. Tears it all down: browser, wrangler (its whole process group), the temp
   profile and the temp D1.

## What the spec checks, and what it cannot

`qa/bombadil/spec.ts`. Extractors run in the page on every captured state;
properties are checked over the whole sequence of states.

| Property                                                            | Catches                                                                                    | Cannot catch                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `noUncaughtExceptions`, `noUnhandledPromiseRejections` (Bombadil's) | any uncaught error or rejection in the page                                                | errors the app catches and swallows; errors in workers or the service worker                                                            |
| `noConsoleErrors` (Bombadil's)                                      | any `console.error`, including React's warnings logged as errors                           | `console.warn`; a failure the app reports only in its UI                                                                                |
| `noServerErrors`                                                    | a 500, 501, 503… on a page load, fetch, script or image (Resource Timing `responseStatus`) | 502 / 504 (left out: the sandbox makes every upstream unreachable); errors in a response body with status 200; requests made by workers |
| `staysOnLocalhost`                                                  | the tab on any origin but the one it started on, or off loopback                           | — (the runner also blocks it at DNS and per request)                                                                                    |
| `neverInPaymentFlow`                                                | a checkout / payment / redeem path, or a Stripe, PayPal, Paddle… script, frame or form     | a payment step that lives on a path not in `CHECKOUT_PATH`                                                                              |
| `leavesPaymentPagesAtOnce`                                          | anything done on `/membership` and other payment pages but leaving them                    | — it checks the spec's own boundary; the app may still route there by itself (that is allowed, and shown)                               |
| `wordsProgressInRange`                                              | a list's progress ring (`data-progress`) outside 0–100 or not whole                        | a wrong percentage inside the range (the oracle does not know the right one)                                                            |
| `wordsRowsDistinct`                                                 | two rendered slips with the same row index, or a negative one (the virtual list)           | a slip that should be shown and is not; rows outside the rendered window                                                                |
| `wordsOneGradePerSlip`                                              | a slip with more than one grade stamp                                                      | a wrong grade, or a grade the server did not store                                                                                      |

**Diagnostic, not enforced:** "a word graded in this session (one list, one
page load) shown again as new in another row". The DOM exposes no card id,
only the term, so a list that holds a term twice would trip it falsely. The
spec still extracts it (`words.newAfterGraded`), and the runner prints what it
saw after the run as an observation; it never fails the run.

The oracle is the page itself: properties see only what the DOM, Resource
Timing and the console show. They know nothing of the scheduler's intended
order, FSRS values or what D1 stored; `qa-words` and `qa-api` check those.
Coverage is random: a short run reaches a handful of pages and some /words
grading (keys 1–4, arrows, space, Z), not every flow. Network-backed features
(AI, TTS, imports from other sites) are unreachable here by design.

### Actions

Bombadil's clicks, text input and scrolling, restricted to the app:

- clicks on links off the origin, to `mailto:` / `tel:` / `javascript:`, or
  into payment paths are dropped, and so are buttons labelled sign out, delete
  account, upgrade, buy, subscribe, checkout, pay;
- `Back` only to an entry on the origin (the first entry is `about:blank`);
- on /words with slips on screen, the grading keys;
- `backToWords`: from any other page, back to the study list;
- on a payment page, the only action is to leave it (`Back`, or straight to
  /words).

## First run (2026-11-21, commit a82d0302)

`bun scripts/qa/bombadil.ts --time 4m`: 4111 states, 54 paths, exit 2 with 20
violations. The full trace, screenshots and log are kept outside the repo at
`~/lianki-qa-evidence/bombadil/2026-11-21-run-4m-a82d0302/` (109 MB; open it
with `bombadil browser inspect <dir>`).

```
✗ noUncaughtExceptions: 16 state(s)
    "Uncaught TypeError: t.learning.replace is not a function"   at /self-intro
    "Uncaught Error: Minified React error #418; ...args[]=HTML"  at /pt/blog/2026-10-17-language-puzzle-games
✗ noUnhandledPromiseRejections: 4 state(s)
    "Uncaught (in promise) AbortError: Uncaught exception in event handler."  at /list
```

The first is `app/(app)/self-intro/SelfIntroClient.tsx`, the interview
heading: `.replace()` on an intlayer node instead of its `.value`.

## Script entry

None in `package.json` yet. The intended one:
`"qa:bombadil": "bun scripts/qa/bombadil.ts"`.
