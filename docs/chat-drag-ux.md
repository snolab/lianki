# Li Chat Window: Drag, Snap, Dock & Minimize UX Proposal

Status: Proposal ready for implementation (2026-11-27, owner requests 06:07–06:10 JST).
Source files: [DebugChat.tsx](../packages/debug-chat/src/DebugChat.tsx), [full-screen.ts](../packages/debug-chat/src/full-screen.ts), [fold.ts](../packages/debug-chat/src/fold.ts), [drag-frame.ts](../packages/debug-chat/src/drag-frame.ts), [dock-resize.ts](../packages/debug-chat/src/dock-resize.ts), [partner-frame.ts](../src/partner-frame.ts), [config.ts](../lib/config.ts).

## 1. Goals & Design Principles

1. **Immediate spatial affordance without resting clutter**: At rest, no drop zones are shown. As soon as a drag crosses the move threshold (`chat.dragThresholdPx`, default `5` px), **subtle target zones with icon + short label** fade in at the valid edges/corners so the user sees every available action regardless of where they started dragging.
2. **True ghost preview (what you see is what you get)**: Hovering a zone highlights its pill and renders a **translucent ghost wireframe of the exact resulting rectangle** (`previewRect`). On wide screens, bottom-edge fullscreen previews the full viewport and produces fullscreen, while right-edge dock previews the right sidebar and produces the right sidebar—eliminating the current wide-screen mismatch.
3. **Pointer-driven hit testing**: Zones trigger on **pointer position** (`clientX, clientY`), not on clamped bar bottom, so dragging from the left grip, bar background, or pill reaches every zone predictably.
4. **Reversible & accessible**: `Escape` or `pointercancel` during a drag cancels cleanly and restores the exact pre-drag snapshot; keyboard focus on the grip supports arrow nudging and snap shortcuts; `prefers-reduced-motion: reduce` disables scale/spring transitions.
5. **One geometry contract across surfaces**: A pure `snapTargets()` helper drives main-site `DebugChat`, bundled `随身Li`, and `随身Li` frame shell (`partner-frame.ts`), with no competing nested drags.

---

## 2. State & Zone Mapping (`snapTargets`)

Pure helper `snapTargets(vp)` takes `{ vw, vh, offsetTop, offsetLeft, safeTop, safeRight, safeBottom, safeLeft, wide, fullAllowed, canDock, dockWidth }`:

| Zone ID | Availability | `hitRect` (pointer, in visual viewport) | `previewRect` & Drop Result | Zone Pill Label |
| --- | --- | --- | --- | --- |
| `fullscreen` | `fullAllowed && !full` (main site only) | Bottom strip excluding bottom-right corner: `x ∈ [offsetLeft, offsetLeft + vw - cornerW]`, `y ∈ [offsetTop + vh - edgeH, offsetTop + vh]` | `{ x: offsetLeft, y: offsetTop, w: vw, h: vh }` (true full screen on both narrow and wide) | Full screen |
| `dock-right` | `wide && canDock` (`>= 35em`, main site) | Right edge above bottom-right corner: `x ∈ [offsetLeft + vw - edgeW, offsetLeft + vw]`, `y ∈ [offsetTop + safeTop, offsetTop + vh - cornerH]` | Right sidebar `{ x: offsetLeft + vw - W, y: offsetTop, w: W, h: vh }` (`W` from `lk:pref:chat-dock`, clamped `[20rem, vw]`), padding page root by `W` | Dock right |
| `minimize` | Always when open (`!minimized`) | Bottom-right corner: `x ∈ [offsetLeft + vw - cornerW, offsetLeft + vw]`, `y ∈ [offsetTop + vh - cornerH, offsetTop + vh]` | Compact minimized pill rect at bottom-right home | Minimize |
| *(elsewhere)* | Always | Anywhere outside active `hitRect`s (including top edge) | Free move (`dragStep` clamp) + existing left/right half `edge` mirroring | — |

- **Top edge**: Intentionally has no snap zone (bar stays a free panel).
- **Hysteresis & haptic**: Entering a zone triggers `navigator.vibrate?.(cfg("chat.snapHapticMs"))` once per entry. Leaving a zone hides the ghost preview while keeping the subtle zone pills visible until drop/cancel.
- **Drag out of fullscreen / dock**: Dragging the grip/bar upward or away by `>= cfg("chat.fullLeavePx")` (`48` px) transitions to free move and continues tracking the pointer.

---

## 3. Cancel-Snapshot Contract (Every Mode)

On `begin()` of any drag—regardless of starting mode (`free`, `fullscreen`, `dock-right`, or `minimized`)—capture an immutable pre-drag snapshot:

```ts
type DragSnapshot = {
  mode: "free" | "fullscreen" | "dock-right" | "minimized";
  pos: { x: number; y: number };
  edge: "left" | "right";
  dockWidth: number;
};
```

- **`Escape` during drag**: Immediately aborts the drag, restores the exact `DragSnapshot` (`mode`, `pos`, `edge`, `dockWidth`), clears Tier 1/2 overlays, and writes **nothing** to `lk:debug-chat-pos`, `lk:pref:chat-fold`, or `lk:pref:chat-dock`. (Post-drop `Escape` continues to exit fullscreen/dock when not intercepted by a menu/tree.)
- **`pointercancel`**: Runs the exact same rollback to `DragSnapshot`—never leaves the window stranded or partially saved.
- **Drop outside any zone**:
  - When dragging from `fullscreen` or `dock-right` without crossing `fullLeavePx`, or when dropping a `minimized` drag outside any snap target without committing a move, restores the exact `DragSnapshot`.
  - When in `free` mode (or after crossing `fullLeavePx` out of `fullscreen` / `dock-right`), dropping outside any zone commits the new free `pos` and `edge` mirroring; canceling beforehand via `Escape` or `pointercancel` restores `DragSnapshot`.

---

## 4. Viewport Geometry Contract (`visualViewport`, Safe Areas, Resize & Rotation)

- **Viewport source of truth**: Read `window.visualViewport` (`vw = vv.width`, `vh = vv.height`, `offsetTop = vv.offsetTop`, `offsetLeft = vv.offsetLeft`) when present, falling back to `window.innerWidth` / `window.innerHeight` with `0` offsets. This keeps `dragStep`, `snapTargets`, and `previewRect` accurate when the mobile keyboard or dynamic browser toolbars are visible.
- **Safe-area insets & OS gesture clearance**: Read `safeTop`, `safeRight`, `safeBottom`, `safeLeft` (from `env(safe-area-inset-*)` plus `--lk-bottom-reserve`).
  - `dragStep` clamps the bar to `x ∈ [offsetLeft + safeLeft, offsetLeft + vw - bar.width - safeRight]` and `y ∈ [offsetTop + safeTop, offsetTop + vh - safeBottom]`.
  - Tier 1 zone pills are inset by `safe*` + a minimum `20` px gesture margin so bottom/side zones do not collide with iOS home-indicator or Android edge-back gestures.
- **随身Li (`partner-frame.ts`) host viewport**: The userscript shell measures the **host page's** `visualViewport` / `innerWidth` × `innerHeight`, never the `420×560` iframe viewport. When `DebugChat` is mounted inside `partner-frame`, its inner iframe `useDrag` is disabled so only the host-side drag controller runs.
- **Resize & rotation**: Subscribe to `window.resize`, `visualViewport.resize` / `scroll`, and `orientationchange`:
  - Re-evaluate `wide = vw >= 35em` (`SIDEBAR_QUERY`). If a viewport shrink/rotation moves from `wide` to narrow while in `dock-right`, transition cleanly to `fullscreen` (and remove page-root right padding); if wide again, restore `dock-right` or keep `free` per state.
  - If a resize/rotation happens during an active drag, roll back to `DragSnapshot` (or re-clamp against the new viewport) and run `fit()` so the bar never ends up off-screen.

---

## 5. Visual Feedback & Keyboard Accessibility

- **Tier 1 — Drag-start zone pills** (`z-index: chat - 1`, `pointer-events: none`): Appear once movement crosses `chat.dragThresholdPx` (`5` px). Glass pill (`color-mix(in oklch, var(--background) 75%, transparent)`, `backdrop-filter: blur(8px)`) with icon + localized label; hovered pill scales to `1.04` with primary accent border.
- **Tier 2 — Ghost destination wireframe** (`data-testid="debug-chat-snap-preview"`): Shown only while pointer is inside a `hitRect`, matching `target.previewRect` exactly (`chat.snapHintMs` ease-out, instant under `prefers-reduced-motion: reduce`).
- **Keyboard path**: When the grip (`data-testid="debug-chat-pill-min"`) is focused, `Arrow` keys nudge `pos` by `16` px (`48` px with `Shift`), clamped by `dragStep` and saved; the grip menu exposes `Full screen`, `Dock right`, and `Minimize` for non-pointer users.

---

## 6. Dead Code Removal & Live Config (`lib/config.ts`)

- **Remove dead code**:
  - `pushedAgainst` and `against` in [fold.ts](../packages/debug-chat/src/fold.ts) / [DebugChat.tsx](../packages/debug-chat/src/DebugChat.tsx).
  - Dormant tucked handle (`tuckEl`, `pressHandle`) in [DebugChat.tsx](../packages/debug-chat/src/DebugChat.tsx).
- **Move hardcoded constants to [config.ts](../lib/config.ts) (`publicCfg`)**:
  - `chat.dragThresholdPx`: `5`
  - `chat.fullLeavePx`: `48`
  - `chat.snapHintMs`: `220`
  - `chat.snapHapticMs`: `10`
  - `chat.snapZoneEdgePx`: `64`
  - `chat.snapZoneCornerPx`: `88`

---

## 7. i18n & Verification Plan

- **i18n**: Add `snapFullscreen`, `snapDockRight`, `snapMinimize` to `packages/debug-chat` content dictionary across all 16 locales with `context` lines.
- **Unit tests**:
  1. `snapTargets()`: non-overlapping `hitRect`s, `visualViewport` offsets + safe-area insets, wide vs narrow (`dock-right` only when `wide && canDock`), `embedded` (`minimize` only), and exact `previewRect` parity.
  2. `DragSnapshot` rollback: `Escape`, `pointercancel`, and no-op outside drops restore exact pre-drag `{ mode, pos, edge, dockWidth }` for every starting mode without storage writes.
  3. Resize/rotation: `dock-right` adapts on wide → narrow transitions and `fit()` keeps the bar inside `visualViewport`.
  4. `partner-frame.ts`: `5` px threshold, rAF clamping in host viewport, `pointercancel` / `Escape` rollback, and bottom-right corner minimize.
