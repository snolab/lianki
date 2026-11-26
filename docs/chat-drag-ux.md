# Li Chat Window: Drag, Snap, Dock & Minimize UX Proposal

Status: Proposal ready for implementation (builds on [drag-inventory](../../drag-inventory.md) from `f8fb6f63`, owner requests 2026-11-27 06:07–06:10 JST).

## 1. Goals & Design Principles

1. **Immediate spatial affordance without resting clutter**: At rest, no drop zones are shown. As soon as a drag crosses the move threshold (`chat.dragThresholdPx`, default `5` px), **subtle target zones with icon + short label** fade in at the valid edges/corners so the user sees every available action regardless of where they started dragging.
2. **True ghost preview (what you see is what you get)**: Hovering a zone highlights its pill and renders a **translucent ghost wireframe of the exact resulting rectangle** (`previewRect`). On wide screens, bottom-edge fullscreen previews the full viewport and produces fullscreen, while right-edge dock previews the right sidebar and produces the right sidebar—eliminating the current wide-screen mismatch.
3. **Pointer-driven hit testing**: Zones trigger on **pointer position** (`clientX, clientY`), not on clamped bar bottom, so dragging from the left grip, bar background, or pill reaches every zone predictably.
4. **Reversible & accessible**: `Escape` or `pointercancel` during a drag cancels cleanly and restores pre-drag coordinates; keyboard focus on the grip supports arrow nudging and snap shortcuts; `prefers-reduced-motion: reduce` disables scale/spring transitions.
5. **One geometry contract across surfaces**: A pure `snapTargets()` helper drives main-site `DebugChat`, bundled `随身Li`, and `随身Li` frame shell (`src/partner-frame.ts`), with no competing nested drags.

---

## 2. State & Zone Mapping (`snapTargets`)

Pure helper `snapTargets(vp)` takes `{ vw, vh, safeTop, safeRight, safeBottom, wide, fullAllowed, canDock, dockWidth }`:

| Zone ID | Availability | `hitRect` (pointer) | `previewRect` & Drop Result | Zone Pill Label |
| --- | --- | --- | --- | --- |
| `fullscreen` | `fullAllowed && !full` (main site only) | Bottom strip excluding bottom-right corner: `x ∈ [0, vw - cornerW]`, `y ∈ [vh - edgeH, vh]` | `{ x: 0, y: vv.offsetTop, w: vw, h: vv.height }` (true full screen on both narrow and wide) | Full screen |
| `dock-right` | `wide && canDock` (`>= 35em`, main site) | Right edge above bottom-right corner: `x ∈ [vw - edgeW, vw]`, `y ∈ [safeTop, vh - cornerH]` | Right sidebar `{ x: vw - W, y: vv.offsetTop, w: W, h: vv.height }` (`W` from `lk:pref:chat-dock`, clamped `[20rem, vw]`), padding page root by `W` | Dock right |
| `minimize` | Always when open (`!minimized`) | Bottom-right corner: `x ∈ [vw - cornerW, vw]`, `y ∈ [vh - cornerH, vh]` | Compact minimized pill rect at bottom-right home | Minimize |
| *(elsewhere)* | Always | Anywhere outside the active `hitRect`s (including top edge) | Free move (`dragStep` clamp) + existing left/right half `edge` mirroring | — |

- **Top edge**: Intentionally has no snap zone (bar stays a free panel).
- **Hysteresis & haptic**: Entering a zone triggers `navigator.vibrate?.(cfg("chat.snapHapticMs"))` once per entry. Leaving a zone hides the ghost preview while keeping the subtle zone pills visible until drop/cancel.
- **Drag out of fullscreen / dock**: Dragging the grip/bar upward or away by `>= cfg("chat.fullLeavePx")` (`48` px) restores the panel to its saved free `pos` and continues tracking the pointer.

---

## 3. Visual Feedback (Two-Tier Overlay)

1. **Tier 1 — Drag-start zone pills** (rendered behind the dragged chat, `z-index: chat - 1`, pointer-events `none`):
   - Appear as soon as `drag` becomes active (`> 5` px).
   - Glass pill (`color-mix(in oklch, var(--background) 75%, transparent)`, `backdrop-filter: blur(8px)`, border, icon + localized label) anchored inside each available zone, respecting `env(safe-area-inset-*)` so they never collide with iOS/Android system gesture bars.
   - Inactive pills sit at subtle opacity (`0.7`); the hovered pill scales slightly (`1.04`) with primary accent border.
2. **Tier 2 — Ghost destination wireframe** (`data-testid="debug-chat-snap-preview"`):
   - Rendered only while the pointer is inside a zone's `hitRect`.
   - Matches `target.previewRect` exactly (`180–220 ms` ease-out transition, instant under `prefers-reduced-motion: reduce`), using translucent accent/background tint + dashed or hairline border.

---

## 4. Cancellation, `pointercancel`, and Keyboard Path

- **`Escape` during drag**: Cancels the drag immediately, restores `pos` to the pre-drag snapshot, does **not** write `POS_KEY`, and clears Tier 1/2 overlays. (Existing post-drop `Escape` continues to exit fullscreen/dock when not intercepted by a menu/tree.)
- **`pointercancel`**: Same rollback as `Escape`—restores pre-drag `pos` instead of leaving the box stranded unsaved.
- **Keyboard accessibility**: When the grip (`data-testid="debug-chat-pill-min"`) has focus:
  - `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` nudge `pos` by `16` px (`48` px with `Shift`), clamped by `dragStep` and saved.
  - Existing menu (`Full screen`, `Dock right`, `Minimize`) provides non-drag access to every snap state.

---

## 5. 随身Li Frame Path (`src/partner-frame.ts`) Unification

- **Shell drag**: Replace the raw `pointermove` style-writing handler with a host-side controller using `requestAnimationFrame` batching, `5` px move threshold, viewport clamping (`dragStep`), and `pointercancel` / `Escape` rollback.
- **Shared snap**: Call `snapTargets({ ..., fullAllowed: false, canDock: false })` on the host viewport so the bottom-right corner offers **Minimize** (`minimize`) with the same visual pill + ghost preview; drop toggles minimized state cleanly instead of relying on desktop-only `dblclick`.
- **Single drag owner**: When `DebugChat` runs inside the `partner-frame` iframe, disable the inner `useDrag` so there are never two competing drag handlers.

---

## 6. Dead Code Removal & Live Config (`lib/config.ts`)

- **Remove dead code**:
  - `pushedAgainst` and `against` in `fold.ts` / `DebugChat.tsx`.
  - Dormant tucked handle (`tuckEl`, `pressHandle`) in `DebugChat.tsx`.
- **Move hardcoded constants to `lib/config.ts` (`publicCfg`)**:
  - `chat.dragThresholdPx`: `5`
  - `chat.fullLeavePx`: `48`
  - `chat.snapHintMs`: `220`
  - `chat.snapHapticMs`: `10`
  - `chat.snapZoneEdgePx`: `64`
  - `chat.snapZoneCornerPx`: `88`

---

## 7. i18n & Verification Plan

- **i18n**: Add `snapFullscreen`, `snapDockRight`, `snapMinimize` (plus short `aria` hints if needed) to `packages/debug-chat` content dictionary across all 16 locales with `context` lines.
- **Unit tests**:
  1. `snapTargets()` geometry: non-overlapping `hitRect`s (`fullscreen` bottom strip vs `minimize` bottom-right corner), wide vs narrow (`dock-right` only when `wide && canDock`), `embedded` (`minimize` only), and exact `previewRect` parity with resulting state.
  2. `useDrag` / `DebugChat`: Tier 1 pills visible immediately on drag start, Tier 2 ghost matches hovered zone, `Escape` and `pointercancel` roll back to pre-drag `pos`.
  3. `partner-frame.ts`: 5 px threshold, rAF clamping within host viewport, `pointercancel` rollback, and bottom-right corner minimize.
