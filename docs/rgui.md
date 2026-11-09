# rgui — our component library

`packages/rgui` is [snomiao/rgui](https://github.com/snomiao/rgui), the
owner's own library (MIT, TypeScript): "Renormalization Group UI". Zoom is
treated as an RG flow: everything snaps to a screen-adaptive radix grid, and
whatever cannot be drawn readably at the current scale is replaced by a
readable abstraction (semantic-zoom LOD), never dropped. Upstream ships a
Canvas 2D renderer (WebGPU next), the lane (1-D timeline / tree folds) and
demo apps. Owner, 2026-11-09 15:33 JST: bring it in as Lianki's component
library, reuse its algorithms, keep our rendering light (DOM/SVG, windowed),
because its Canvas display may be too heavy for us.

## What we use, and what we do not

The app imports **only** `@snomiao/rgui/gantt` (`packages/rgui/src/gantt/`,
our module, added in this repo). It is pure functions, no DOM:

| file        | what                                                                                  | from rgui                                    |
| ----------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `scale.ts`  | linear axis (grows on demand, trimmed) and symmetric-log axis around Now; zoom, to-Now | unit lengths: `lane/temporal.ts FOLD_PERIOD_MS` |
| `ticks.ts`  | tick choice: finest readable step; log ticks whose labels never overlap                | `core/grid.ts readableStep` (radix ladder past the last rung) |
| `layout.ts` | task → bar (`ganttBar`), row order, range; LOD `layoutGantt`; `windowRows`            | `core/rule.ts` (clusterGapPx), `lane/treefold.ts chunkRows` (cluster label) |

`layoutGantt` is rgui's LOD on a Gantt: a run of consecutive rows whose bars
are too thin to read (under `READABLE_BAR_PX`, e.g. done tasks weeks away on
the log axis) and within `clusterGapPx` of each other on screen folds into one
pseudo-row, "first name… ×N", its bar their union. Open tasks never fold.

Never imported by the app: `src/index.ts` (the whole library, with
d3-zoom, three and the Canvas/WebGPU renderers), `src/render/**`, the demo
entries (`*-main.ts`, `index.html`, `lane/`, `cube/`, `world/`, `calendar/`).
Nothing reaches the Next/Worker bundle unless it is imported, and the root
`tsconfig.json` excludes `packages/rgui` (the path `@snomiao/rgui/gantt`
points at the gantt module, which is type-checked through its imports).

Lianki's full-screen Gantt (`packages/debug-chat/src/GanttFull.tsx`,
[dev-debug-widget.md](dev-debug-widget.md), "Full-screen Gantt") draws on the
gantt module: `gantt-view.ts` re-exports its scales, ticks and bars unchanged
and keeps only Lianki's own colours and pinch/wheel helpers. `layoutGantt`'s
clusters and `windowRows` are **not wired in yet**: GanttFull draws one DOM
row per task. Wiring them needs a cluster row in GanttFull (sticky label,
union bar, a tap that unfolds it) and new QA checks for it in
`scripts/dev/debug-chat-gantt-qa.mjs` (today's check "every name in view"
assumes one row per task).

## Our edits to upstream files

Kept small so `subtree pull` merges cleanly:

- `package.json`: an `exports` entry `"./gantt": "./src/gantt/index.ts"`.
- `README.md`: a vendoring note at the top (attribution, link here).
- `lib/sflow` (an upstream git submodule, a research reference) and
  `.gitmodules` are removed: we vendor without submodules. If a pull brings
  them back, `git rm --cached packages/rgui/lib/sflow` and
  `git rm packages/rgui/.gitmodules` again.
- New: `src/gantt/**` — ours; may be offered upstream later.

## Build, types, tests

- It is a workspace package (`@snomiao/rgui`); `bun install` installs its
  deps (d3, three, vite …) next to it. `cd packages/rgui && bun run typecheck`
  checks it with its own `tsconfig.json`; `bun test` there runs upstream's
  suites (its `bunfig.toml` roots them at `src`).
- Our suites: `unit/rgui-gantt.test.ts` and `unit/gantt-view.test.ts` hold the
  gantt module to 100%. The root `bunfig.toml` ignores upstream's
  `src/core/**` and `src/lane/**` for coverage (loaded only as dependencies).
- Lint/format: the root lint skips `packages/**`, so upstream's style stays
  upstream's.

## Sync with upstream

```bash
# pull upstream's main into packages/rgui (squashed, one merge commit)
git subtree pull --prefix packages/rgui https://github.com/snomiao/rgui main --squash
bun install                       # if its deps changed
cd packages/rgui && bun run typecheck && bun test
cd - && bun test unit/rgui-gantt.test.ts unit/gantt-view.test.ts
bun scripts/dev/debug-chat-gantt-qa.mjs   # the Gantt in a browser
```

`main` is linear (squash merges only). `subtree pull` finds the last sync by
the `git-subtree-dir: packages/rgui` / `git-subtree-split: <upstream sha>`
lines in a commit message on `main`; the repo's squash message is the PR's
commit messages, so they survive as long as the sync PR's "Squashed
'packages/rgui/' …" commit is in it (never rewrite or rebase that commit;
rebasing it would replay upstream's files at the repo root). Verified in a
scratch repo on 2026-11-09: add at an old upstream commit, squash to one
commit carrying the two lines, a local edit, then `subtree pull --squash` to
upstream main: only `packages/rgui` changed, the local edit kept.

To offer `src/gantt/` back upstream: `git subtree push --prefix packages/rgui
<fork-url> <branch>` and open a PR there (the owner's repo).
