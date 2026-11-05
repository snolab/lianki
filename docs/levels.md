# Learner levels

Six levels, one id each (`lv1`…`lv6`), the same in every locale. Owner
decisions, Slack 2026-11-05 (thread on renaming the paid tier / 修仙体系).

| id    | lotus (most locales) | cultivation (zh / ja / ko) | how it is reached                        |
| ----- | -------------------- | -------------------------- | ---------------------------------------- |
| `lv1` | Seed                 | 炼气 / 錬気 / 연기         | using Lianki without an account (guest)  |
| `lv2` | Root                 | 筑基 / 築基 / 축기         | signed in, free account                  |
| `lv3` | Stem                 | 金丹                       | paying — the entry level                 |
| `lv4` | Bud                  | 元婴 / 元嬰 / 원영         | paid + 100 study days                    |
| `lv5` | Bloom                | 化神 / 화신                | paid + 365 study days                    |
| `lv6` | Lotus                | 炼虚 / 錬虚 / 연허         | paid + 1000 study days                   |

"付费之后按学习进度升，慢慢解锁": after paying, levels rise with learning
progress. Progress is **cumulative study days** counted from the first paid
day — not a streak, gaps don't reset.

## Where it lives

- `lib/levels.ts` — ids, stage, `tier` (`guest` | `free` | `paid`),
  `unlock` (`tier` | `progress`), `studyDays`, and `ladderFor(locale)`.
- `app/components/level-badge.content.ts` — dictionary `learner-levels`: the
  names. Each locale's value comes from its own ladder (so the zh value is not
  a translation of the en one); the context lines say so.
- `app/components/level-badge.tsx` — `LevelBadge {level, size, locked, label}`:
  one hand-drawn SVG per level, lotus growth in ink and seal red, an ensō halo
  on the last. The same badge serves the cultivation ladder (a lotus rising
  through stages). The name is never drawn in the badge.
- `/dev/levels` (owner only) — gallery: both themes, 96px and 20px, locked and
  unlocked, zh and en names.

## Badge rules

- Ink is `currentColor` (override: `--lk-badge-ink`); seal is
  `--lk-badge-seal`, falling back to `--brand`, which already flips for dark.
- Legible at 20px (nav chip) and 96px (profile): filled brush strokes, the
  thinnest about a pixel at 20px.
- `locked` = the same silhouette in faint ink, no red: a level not reached.

## Not done yet

Nothing user-facing shows a level. Computing a user's level (study days from
server-recorded reviews) is the next step.
