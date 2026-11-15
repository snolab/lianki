/**
 * GanttFull renders with a changing number of task rows. Its per-bar helper
 * once called a hook, so the hook count followed the row count and React threw
 * "Rendered more hooks than during the previous render" the moment the owner
 * opened the Gantt from the ETA bar (2026-11-15 22:1x JST). Mounting with one
 * task and re-rendering with three must not throw.
 */
import { expect, it } from "bun:test";
import type { EtaTask } from "@lianki/debug-chat/eta";
import { GanttFull } from "../packages/debug-chat/src/GanttFull";
import { CHAT_STRINGS_EN } from "@lianki/debug-chat/wire";
import { stubGlobals } from "./support/globals";

const MIN = 60_000;
const task = (id: string, at: number, by = "codex"): EtaTask => ({
  id,
  title: `${id.slice(1)}: what it does`,
  start: 0,
  at,
  ticks: [{ at: 0, kind: "change", changeId: "c", by }],
});

it("more rows on a later render: no hook-order error", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  // The Gantt measures and animates: the browser bits happy-dom lacks are stubbed.
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: g.getComputedStyle ?? ((el: unknown) => win.getComputedStyle(el as never)),
    requestAnimationFrame:
      g.requestAnimationFrame ?? ((f: (t: number) => void) => setTimeout(() => f(0), 0)),
    cancelAnimationFrame: g.cancelAnimationFrame ?? ((h: unknown) => clearTimeout(h as never)),
    ResizeObserver:
      g.ResizeObserver ??
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    matchMedia:
      g.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a[0]);
  const render = (tasks: EtaTask[]) =>
    act(() =>
      root.render(
        <GanttFull tasks={tasks} now={10 * MIN} strings={CHAT_STRINGS_EN} onClose={() => {}} />,
      ),
    );
  try {
    await render([task("/a", 30 * MIN)]);
    await render([task("/a", 30 * MIN), task("/b", 45 * MIN, "agy"), task("/c", 90 * MIN)]);
    await render([task("/c", 90 * MIN)]);
    const hookErrors = errors.filter((e) => /hooks/i.test(String(e)));
    expect(hookErrors).toEqual([]);
    await act(() => root.unmount());
  } finally {
    console.error = origError;
    restore();
  }
});
