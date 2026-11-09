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

## Study days (how lv4–lv6 are reached)

`lib/study-days.ts`, table `study_day` (`db/migrations/0042_study_days.sql`):
one row per user per local day, a daily rollup, so a level is one indexed
`COUNT(*)` on the primary key — no scan of the review logs, no polling.

Hard to fake, by construction (owner, Slack 2026-11-05):

- **Server-recorded only.** The row is written by the review routes
  (`/api/words/lists/[id]/review`, `/api/read/[id]/grade`) right after the
  review is stored, with the **server's clock**. A review's own `reviewedAt`
  (an offline grade sent later, or a device with its clock moved) never picks
  the day: it lands on the day the server received it.
- **The day is cut in the user's time zone** — the zone Cloudflare places the
  request in (`request.cf.timezone`, from the IP), fixed at the first study day
  as the **home zone**; later requests from other zones (a VPN, a trip) are
  still cut in the home zone, so one real day can't become two dates.
- **Real reviews only.** A review counts if its card was on screen at least
  human reaction time (`HUMAN_REACTION_MS` = 1 s, the low end of the 1–3 s
  rule): /words sends `elapsedMs` only for the row in focus, so grades tapped
  on other rows (mass-tapping) carry none and don't count; /reader uses the
  swipe's shown → swiped time, and a resent grade (same client id) is not a
  new read. Selection batch grades and the Easy-grades-the-words path don't
  count.
- **One count per day** however many reviews; never more days than calendar
  days since the first paid day (`capDays`); keyed to the account's email.
- **Counted from the first paid day**: the earliest live payment (test-mode
  ones excluded), pass bought with credits, or Pro given (sponsor, gift,
  referral). Not a streak — gaps don't reset. If Pro lapses the level falls
  back to lv2 while the days are kept for when it is renewed.

Study days are recorded for everyone whatever the flag says, so nobody loses
days before levels are shown.

Each closed day's rows are anchored by the daily cron into the study ledger
(salted Merkle leaves, a hash chain; [lian.md](lian.md)), so a recorded day
cannot be changed afterwards without it showing.

## Showing it

Flag `levels` (docs/feature-flags.md): on, everyone sees their level; off
(default), only the owner. The gate is `levelsOn(flags, owner)` in
`lib/level-progress.ts`, decided on the server.

- **Nav chip** — `app/components/LevelChip.tsx`, next to the avatar in the top
  bar (AppShell), signed-in users only: the 20px badge, the name beside it
  from `sm` up (phones: the badge alone, so the bar stays uncrowded). Links to
  /profile; its accessible name is "Your level: {level}". It reads
  `GET /api/levels/me` once per tab, kept in memory for 60 s (business data,
  so not sessionStorage — docs/ui-state.md); no polling.
- **Profile card** — `app/components/LevelCard.tsx` on /profile, read on the
  server: the 96px badge, the name from the locale's ladder, study days so far
  (paid, or days kept from a lapsed Pro), the progress line, and the row of all
  six levels with the ones not reached drawn faint (`locked`). The progress
  line (`levelProgress` / `progressText`): paid → "再学 N 天升到 …" with N
  from the data (plural form by `Intl.PluralRules`); free → "Get Pro to reach
  …" (links /membership); guest → "Sign up to reach …" (links /sign-in); lv6
  → the top. A signed-out visitor gets /profile with the guest card only while
  levels are on; otherwise /profile still sends them to sign in.
- Strings: dictionary `learner-level-ui` (`app/components/level-ui.content.ts`),
  each key with its context line.
- `/dev/levels` (owner only) — the debug view: badge, tier, study days, first
  paid day, the last 14 study days, then the badge gallery.

## Open

- Trial (the 90 days every new account gets) counts as **free**, not paid.
- Pro that was given (sponsor, gift code, referral reward) counts as paid,
  like Pro that was bought. To be confirmed by the owner.
- `elapsedMs` / `shownAt` are measured on the device; a modified client could
  send fake durations, but still at most one day per real server day.
