import type { Meta, StoryObj } from "@storybook/html";

import { CURSOR, GOOD, INFO, PAGE_PHONE, an, arrow, frame, pill, type FrameArgs } from "./mock";

/**
 * The tucked handle, owner follow-up: big enough for a beginner's thumb, in two
 * shapes to pick from — a half-circle bulging out of the screen edge, or a
 * rounded square. Android's back gesture is a horizontal swipe from the screen
 * edge, so the handle's touch area stays inset from the very edge: it opens by
 * a tap, or by press-and-drag that starts on the handle — never by pulling
 * from the edge. A new message lights a dot on it and peeks its first line.
 */

type Shape = "half" | "square";
interface HandleArgs extends FrameArgs {
  shape: Shape;
}

/** The strip next to the edge Android keeps for its back swipe (≈ 20px). */
const STRIP = 20;
/** Half-circle radius: it bulges R from the edge, 2R tall. */
const R = 52;
/** Rounded square side, inset past the back-gesture strip. */
const SQ = 60;

const HANDLE_CSS = `
.hd { position: absolute; background: var(--glass-solid); border: 1px solid var(--line); box-shadow: var(--shadow); display: grid; place-items: center; }
.hd.half { width: ${2 * R}px; height: ${2 * R}px; border-radius: 50%; }
.hd.half .w-mark { position: absolute; left: ${R / 2 - 16}px; }
.hd.square { width: ${SQ}px; height: ${SQ}px; border-radius: 18px; }
.hd .w-mark { width: 32px; height: 32px; font-size: 13px; }
.hd-dot { position: absolute; width: 16px; height: 16px; border-radius: 50%; background: var(--warn); border: 3px solid var(--background); }
.hd-touch { position: absolute; border: 2.5px dashed oklch(0.6 0.15 150); border-radius: 14px; background: oklch(0.6 0.15 150 / 0.1); }
.hd-strip { position: absolute; top: 0; bottom: 0; width: ${STRIP}px;
  background: repeating-linear-gradient(135deg, oklch(0.62 0.22 27 / 0.28) 0 6px, transparent 6px 12px); border-left: 2px solid oklch(0.62 0.22 27 / 0.6); }
.hd-ghost { position: absolute; border: 2px dashed var(--muted); opacity: 0.6; }
.hd-finger { position: absolute; width: 50px; height: 50px; border-radius: 50%; background: oklch(0.55 0.03 65 / 0.35); border: 3px solid oklch(0.98 0.01 82 / 0.9); box-shadow: 0 2px 8px oklch(0 0 0 / 0.25); }
.hd-peek { position: absolute; height: 44px; display: flex; align-items: center; padding: 0 14px; background: var(--glass-solid);
  border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: 14px; font-size: 15px; white-space: nowrap; }
`;

interface Geo {
  vw: number;
  cy: number;
}

/** The handle, its right side on the screen's right edge, centred on cy. */
const handle = (shape: Shape, g: Geo, dot = false) => {
  const mark = `<div class="w-mark">Li</div>`;
  if (shape === "half") {
    const left = g.vw - R;
    return `<div class="hd half" style="left:${left}px;top:${g.cy - R}px">${mark}</div>${
      dot ? `<div class="hd-dot" style="left:${left + 4}px;top:${g.cy - R + 10}px"></div>` : ""
    }`;
  }
  const left = g.vw - STRIP - SQ;
  return `<div class="hd square" style="left:${left}px;top:${g.cy - SQ / 2}px">${mark}</div>${
    dot ? `<div class="hd-dot" style="left:${left - 6}px;top:${g.cy - SQ / 2 - 6}px"></div>` : ""
  }`;
};

/** Where the handle takes touches: the part past the back-gesture strip, padded inward. */
const touch = (shape: Shape, g: Geo) => {
  if (shape === "half") {
    const h = 2 * R + 8;
    return `<div class="hd-touch" style="left:${g.vw - R - 16}px;top:${g.cy - h / 2}px;width:${R + 16 - STRIP}px;height:${h}px"></div>`;
  }
  const s = SQ + 16;
  return `<div class="hd-touch" style="left:${g.vw - STRIP - SQ - 8}px;top:${g.cy - s / 2}px;width:${s}px;height:${s}px"></div>`;
};

/** The handle's inner edge (where the peek line ends). */
const innerX = (shape: Shape, vw: number) => (shape === "half" ? vw - R : vw - STRIP - SQ);

const peek = (shape: Shape, g: Geo, text: string, w: number) =>
  `<div class="hd-peek" style="left:${innerX(shape, g.vw) - 10 - w}px;top:${g.cy - 22}px;width:${w}px">${text}</div>`;

const strip = (vw: number) => `<div class="hd-strip" style="left:${vw - STRIP}px"></div>`;

const NAME: Record<Shape, string> = { half: "半圆", square: "方形" };

// ── phone 390×844 ──────────────────────────────────────────────────────────
const PV = 390;
const PG: Geo = { vw: PV, cy: 560 };

const phoneRest = (a: HandleArgs) =>
  frame(
    a,
    `<style>${HANDLE_CSS}</style>
    ${strip(PV)}
    ${handle(a.shape, PG)}
    ${touch(a.shape, PG)}
    ${an(24, 380, "拇指大小的把手，新手一眼能找到", "good")}
    ${arrow(150, 425, innerX(a.shape, PV) - 6, PG.cy - 20, GOOD)}
    ${an(16, 660, "绿框 = 触点：避开最边上那条", "good")}
    ${an(150, 730, "红斜线 = 安卓「从边缘横划 = 返回」区，不放触点")}
    ${arrow(370, 750, PV - 12, 720, "oklch(0.62 0.22 27)")}`,
    PAGE_PHONE,
  );

const phonePeek = (a: HandleArgs) =>
  frame(
    a,
    `<style>${HANDLE_CSS}</style>
    ${handle(a.shape, PG, true)}
    ${peek(a.shape, PG, "Li：复习完了，要开始读吗？", a.shape === "half" ? 236 : 220)}
    ${an(20, 400, "红点 = 有新消息", "good")}
    ${arrow(130, 445, innerX(a.shape, PV) + 2, PG.cy - (a.shape === "half" ? 38 : 34), GOOD)}
    ${an(20, 640, "第一行探出来，几秒后缩回，红点留着", "good")}`,
    PAGE_PHONE,
  );

const phoneDrag = (a: HandleArgs) => {
  const fx = 150;
  const fy = PG.cy - 40;
  const ghost =
    a.shape === "half"
      ? `<div class="hd-ghost" style="left:${PV - R}px;top:${PG.cy - R}px;width:${2 * R}px;height:${2 * R}px;border-radius:50%"></div>`
      : `<div class="hd-ghost" style="left:${PV - STRIP - SQ}px;top:${PG.cy - SQ / 2}px;width:${SQ}px;height:${SQ}px;border-radius:18px"></div>`;
  return frame(
    a,
    `<style>${HANDLE_CSS}</style>
    ${ghost}
    ${pill(fx - 26, fy - 23)}
    <div class="hd-finger" style="left:${fx - 25}px;top:${fy - 25}px"></div>
    ${arrow(innerX(a.shape, PV) + 10, PG.cy, fx + 112, fy + 6, INFO, true)}
    ${an(20, 330, "按住把手往里拖 → 胶囊跟着手指出来，松手就停在那里", "info")}
    ${an(20, 640, "或者轻点把手 → 原地回到胶囊", "info")}
    ${an(20, 720, "不支持「从屏幕边缘往里拉」：那是安卓的返回")}`,
    PAGE_PHONE,
  );
};

// ── desktop 1440×900 ───────────────────────────────────────────────────────
const DG: Geo = { vw: 1440, cy: 700 };
const desktop = (a: HandleArgs) =>
  frame(
    a,
    `<style>${HANDLE_CSS}</style>
    ${handle(a.shape, DG, true)}
    ${peek(a.shape, DG, "Li：复习完了，12 个词全对 ✓ 要开始读《The Quiet Harbour》吗？", 470)}
    ${CURSOR(innerX(a.shape, 1440) + 22, DG.cy + 6)}
    ${an(900, 600, "PC 同样大小：红点 + 第一行探出", "good")}
    ${arrow(1120, 646, innerX(a.shape, 1440) - 4, DG.cy - (a.shape === "half" ? 40 : 34), GOOD)}
    ${an(760, 800, "点一下，或按住拖出来 → 胶囊", "info")}
    ${arrow(1050, 812, innerX(a.shape, 1440) + 14, DG.cy + 20, INFO)}`,
  );

const meta: Meta<HandleArgs> = {
  title: "Chat fold/Tucked handle",
  args: { theme: "light", device: "phone", shape: "half" },
  argTypes: {
    theme: { control: "inline-radio", options: ["light", "dark"] },
    shape: { control: "inline-radio", options: ["half", "square"] },
  },
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<HandleArgs>;

const set = (shape: Shape) => {
  const n = NAME[shape];
  const rest: Story = {
    args: { shape, n: `${n} ①`, caption: "收起（静止）", note: "拇指大小 · 触点避开边缘" },
    render: phoneRest,
  };
  const pk: Story = {
    args: { shape, n: `${n} ②`, caption: "来新消息", note: "红点 + 第一行探出" },
    render: phonePeek,
  };
  const drag: Story = {
    args: { shape, n: `${n} ③`, caption: "按住拖出 / 轻点", note: "回到胶囊" },
    render: phoneDrag,
  };
  const dark = (s: Story): Story => ({ ...s, args: { ...s.args, theme: "dark" } });
  const pc: Story = {
    args: { shape, device: "desktop", n: `${n} · PC`, caption: "收起时来新消息", note: "1440×900" },
    render: desktop,
  };
  return { rest, pk, drag, restD: dark(rest), pkD: dark(pk), dragD: dark(drag), pc };
};

const half = set("half");
const square = set("square");

export const HalfRest = half.rest;
export const HalfPeek = half.pk;
export const HalfDrag = half.drag;
export const HalfRestDark = half.restD;
export const HalfPeekDark = half.pkD;
export const HalfDragDark = half.dragD;
export const HalfDesktop = half.pc;

export const SquareRest = square.rest;
export const SquarePeek = square.pk;
export const SquareDrag = square.drag;
export const SquareRestDark = square.restD;
export const SquarePeekDark = square.pkD;
export const SquareDragDark = square.dragD;
export const SquareDesktop = square.pc;
