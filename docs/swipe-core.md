# The swipe: headless core, island UI, feel tokens

The touch swipe on /words is split in three parts:

1. **A headless core.** It covers the gesture, the physics and the grade.
   It is pure where it can be, built into the app, and never hot-swapped.
2. **UI islands.** These are the card, its lift, what it uncovers, the feel
   source and the tuner. Each is a plain component that reads the core
   through React context. Each one can be swapped on its own with hot islands
   ([dev-hot-islands.md](dev-hot-islands.md)).
3. **Feel tokens.** Every number the physics and the cues read is in one
   object, with a "light" and a "heavy" preset.

Thresholds and grades are not tokens. They stay in `lib/words/swipe.ts`
(levels, hysteresis, `releaseRating`, `restRating`) and are the same on
every feel.

| File                               | Role                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `lib/words/swipe-physics.ts`       | spring (mass/stiffness/damping, exact), fling, rubber band, release path |
| `lib/words/swipe-machine.ts`       | the gesture as a pure state machine: events in, effects out              |
| `lib/words/swipe-feel.ts`          | `SwipeFeel` tokens, the presets, prefs parsing, `resolveFeel`            |
| `lib/words/swipe-core.tsx`         | the React core: contexts, `useSwipeGesture`, prefs store (shared module) |
| `lib/words/islands/*.tsx`          | the UI islands                                                           |
| `app/(app)/words/WordsClient.tsx`  | `TouchWordRow` (js) and `NativeSlipRow` (native) wire the core           |
| `unit/swipe-core.test.ts`          | physics, machine, tokens, the interface                                  |
| `scripts/qa/qa-words.mjs`, "heavy" | end to end on the phone, both swipes                                     |

## Interface v1 (`SWIPE_CORE_IFACE`)

Islands import only `@/lib/words/swipe-core`, which is a shared module, so
a hot-loaded island reads the page's own contexts.

```ts
useSwipeFeel(1): {
  iface: 1;
  feel: SwipeFeel;          // tokens in force
  preset: "light" | "heavy";
  overridden: boolean;      // ?feel= decides this page load
  prefs: { preset; tweaks: Partial<SwipeFeel>; tune: boolean };
  setPrefs(p): void;        // preset+tweaks: localStorage lk:pref:swipe-feel; tune: sessionStorage lk:ui:swipe-tuner
  reducedMotion: boolean;
  publish(source, tune | null): void;
}
useSwipeRow(1): {
  iface: 1;
  variant: "js" | "native";
  phase: "idle" | "pressed" | "dragging" | "scrolling" | "holding" | "settling";
  feel: SwipeFeel;
  reducedMotion: boolean;
  card: { bind: { ref, onPointerDown/Move/Up/Cancel }; index; className; style; children } | null;
}
useFeelTune(1, source, { light?: Partial<SwipeFeel>, heavy?: Partial<SwipeFeel> })
```

Each island passes the version it was written for. If the version does
not match, the hook throws, and the island's error boundary shows the
built-in island. If you change a shape, bump `SWIPE_CORE_IFACE` and the
islands' `ISLAND_VERSIONS` in `lib/islands/contract.ts`. An island built
against the old version is then skipped by the loader as well.

The phase changes only when a gesture starts or ends. The core writes the
card's transform straight to the element once a frame, and that never
causes a React render.

## Islands

| Island              | What it is                                                    |
| ------------------- | ------------------------------------------------------------- |
| `words.swipeCard`   | the js slip: renders the core's card slot (element + content) |
| `words.swipeCue`    | the lift: a shadow under a pressed or dragged slip            |
| `words.swipeGrades` | what a sliding slip uncovers (both swipes)                    |
| `words.swipeFeel`   | a feel source: publishes `TUNE` while mounted                 |
| `words.swipeTuner`  | the tuning panel (debug mode, Settings → Tune swipe)          |

They compose through the core's context, not through each other. The row
puts `<SwipeCueIsland/>` into the card slot's children, and the card island
renders those children. Islands never import each other.

## The feel

| token                            | light              | heavy                    |
| -------------------------------- | ------------------ | ------------------------ |
| mass / stiffness / damping       | 1 / 900 / 60 (ζ 1) | 2.2 / 600 / 64 (ζ .88)   |
| followOmega (drag lag)           | 0 (none)           | 36 rad/s (~55 ms)        |
| snap (level hold)                | 0.9                | 0.9                      |
| stretch / rubberBand past 2a     | 0.3 linear / 0     | — / 0.45 (eases to 2.5a) |
| flingCarry / friction / maxFling | 0 / 0 / 0          | 0.55 / 7 s⁻¹ / 2200 px/s |
| lift / liftMs                    | 0 / 0              | 1 / 140 ms               |
| nativeRelease                    | false              | true                     |

On "light", the swipe is the one that shipped. The release is the critically
damped spring at ω = 30, the same as the old `SWIPE_SPRING`.

On "heavy", the slip trails the finger a little. Past the last level it
eases into a rubber band. It never tilts: the slip only translates. When you lift your finger,
part of the finger's speed carries the slip on under friction, slowing
down. Then a heavier spring brings it home, with one faint overshoot under
1% of the travel.

For the New swipe (native scrolling), `nativeRelease` stops the browser's
own coast and snap when the finger lifts. The slip then follows the same
release path, written to `scrollLeft`. The grade is decided at the lift,
with `releaseRating`'s tiers. The drag itself stays the browser's, so it
follows the finger 1:1, with no lag or rubber band.

`prefers-reduced-motion`: there is no lag and no coast, and the
lift appears without a transition. The slip goes home at once, and grades
the same.

## Turning it on (per device)

- Debug mode on (seven quick taps on /words Settings), then Settings →
  Experimental → **Heavy swipe**. **Tune swipe** opens the panel.
- `?feel=heavy` (or `light`) applies for one page load and is never stored.
- Everyone else stays on light. Telemetry rows get `feel=heavy`, or
  `feel=<preset>+N` when N tokens are tweaked. They get nothing on the plain
  light feel, so older rows still compare. `/dev/swipe-ab` can split by it.

## Tuning live from the Mac

With hot islands on for the owner's page:

```bash
bun scripts/dev/islands-server.ts --port 5196 --tailnet /lianki-islands
```

Edit `TUNE` in `lib/words/islands/SwipeFeelSource.tsx` (for example
`{ heavy: { damping: 56 } }`) and save. Only that island swaps. The tokens
change for the next swipe, and the list, the queue, the focus and a slip in
mid-drag keep their state, because they live above the island. The tuner
panel's own tweaks are stored on the device and survive swaps and reloads.
