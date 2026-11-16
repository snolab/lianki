import { describe, expect, test } from "bun:test";
import { createLogResizeAnchor } from "../packages/debug-chat/src/log-resize-anchor";

function fixture() {
  let available = true;
  let viewTop = 100;
  const rows = [
    { top: 500, height: 180 },
    { top: 800, height: 180 },
    { top: 1100, height: 180 },
  ];
  const nodes = rows.map((row) => ({
    getBoundingClientRect: () => ({
      top: viewTop + row.top - box.scrollTop,
      bottom: viewTop + row.top + row.height - box.scrollTop,
    }),
  }));
  const box = {
    hidden: false,
    clientWidth: 400,
    clientHeight: 400,
    scrollHeight: 3000,
    scrollTop: 600,
    querySelectorAll: () => nodes,
    contains: (node: unknown) => nodes.includes(node as (typeof nodes)[number]),
    getBoundingClientRect: () => ({ top: viewTop, bottom: viewTop + box.clientHeight }),
  };
  const following = { current: false };
  const anchor = createLogResizeAnchor({
    box: () => (available ? (box as unknown as HTMLElement) : null),
    following,
  });
  anchor.resize();
  anchor.remember();
  return {
    box,
    rows,
    nodes,
    anchor,
    following,
    available: (value: boolean) => {
      available = value;
    },
    moveView: (value: number) => {
      viewTop = value;
    },
  };
}

describe("chat resize reading anchor", () => {
  test("reflow above the focused message keeps its visible position on narrow and wide resizes", () => {
    const { box, rows, nodes, anchor } = fixture();
    const top = nodes[1].getBoundingClientRect().top;
    box.clientWidth = 320;
    rows[1].top += 240;
    anchor.resize();
    expect(box.scrollTop).toBe(840);
    expect(nodes[1].getBoundingClientRect().top).toBe(top);
    anchor.remember();
    box.clientWidth = 500;
    rows[1].top -= 240;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
    expect(nodes[1].getBoundingClientRect().top).toBe(top);
  });

  test("does not double compensate when browser native anchoring already kept the message", () => {
    const { box, rows, anchor } = fixture();
    box.clientWidth = 320;
    rows[1].top += 240;
    box.scrollTop += 240;
    anchor.resize();
    expect(box.scrollTop).toBe(840);
  });

  test("height changes preserve the offset within the log even when its top moves", () => {
    const { box, rows, nodes, anchor, moveView } = fixture();
    box.clientHeight = 300;
    moveView(150);
    rows[1].top += 50;
    anchor.resize();
    expect(nodes[1].getBoundingClientRect().top - 150).toBe(200);
    expect(box.scrollTop).toBe(650);
  });

  test("a partially visible long message is not snapped to its beginning", () => {
    const { box, rows, nodes, anchor } = fixture();
    rows[0].height = 1600;
    anchor.remember();
    const top = nodes[0].getBoundingClientRect().top;
    expect(top).toBe(0);
    box.clientWidth = 320;
    rows[0].top += 250;
    anchor.resize();
    expect(nodes[0].getBoundingClientRect().top).toBe(top);
  });

  test("content-only updates do not scroll or replace the reader's intent", () => {
    const { box, rows, anchor } = fixture();
    box.scrollHeight += 500;
    rows[1].top += 100;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
  });

  test("bottom-following is left to the tail controller, including a queued resize", () => {
    const { box, rows, anchor, following } = fixture();
    following.current = true;
    box.clientWidth = 320;
    rows[1].top += 240;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
    anchor.remember();
    following.current = false;
    box.clientWidth = 450;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
  });

  test("removed messages and an empty log do not navigate to another message", () => {
    const { box, nodes, anchor } = fixture();
    nodes.splice(1, 1);
    box.clientWidth = 320;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
    nodes.length = 0;
    anchor.remember();
    box.clientWidth = 500;
    anchor.resize();
    expect(box.scrollTop).toBe(600);
  });

  test("hidden, unavailable and reset logs discard stale anchors", () => {
    for (const state of ["hidden", "unavailable", "reset"]) {
      const { box, rows, anchor, available } = fixture();
      if (state === "hidden") box.hidden = true;
      if (state === "unavailable") available(false);
      if (state === "reset") anchor.reset();
      else {
        anchor.resize();
        anchor.remember();
      }
      available(true);
      box.hidden = false;
      box.clientWidth = 320;
      rows[1].top += 240;
      anchor.resize();
      expect(box.scrollTop).toBe(600);
    }
  });

  test("restored positions are clamped to the new scroll range", () => {
    const { box, rows, anchor } = fixture();
    box.clientWidth = 320;
    box.scrollHeight = 700;
    rows[1].top += 500;
    anchor.resize();
    expect(box.scrollTop).toBe(300);
    box.clientWidth = 500;
    rows[1].top = 0;
    anchor.resize();
    expect(box.scrollTop).toBe(0);
  });
});
