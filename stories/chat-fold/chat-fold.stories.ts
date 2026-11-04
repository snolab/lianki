import type { Meta, StoryObj } from "@storybook/html";

/**
 * Storyboard for the Li chat widget's fold redesign (packages/debug-chat).
 * Static mocks, not the live component: each story is one frame of the story
 * the owner reviews — today's misalignment, then expanded → pill → tucked into
 * the screen edge, a new message peeking from the tucked handle, dragging to
 * the left edge (everything mirrors), and Li above the /read review.
 * Colours are oklch only; the paper/ink tokens follow app/globals.css.
 */
import {
  CURSOR,
  arrow,
  GOOD,
  INFO,
  an,
  box,
  PAGE,
  PAGE_PHONE,
  REVIEW,
  bar,
  pill,
  PILL_W,
  log,
  float,
  W,
  H,
  PW,
  BX,
  BY,
  HY,
  handle,
  frame,
  type FrameArgs,
} from "./mock";

const meta: Meta<FrameArgs> = {
  title: "Chat fold/Storyboard",
  args: { theme: "light", device: "desktop" },
  argTypes: { theme: { control: "inline-radio", options: ["light", "dark"] } },
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<FrameArgs>;

// ── frames ─────────────────────────────────────────────────────────────────

/** Today, minimized: the bar folds left, the pill ends up on the right, the lines go right. */
export const F0Current: Story = {
  args: {
    n: "0",
    caption: "现状：往左收，消息却靠右",
    note: "按钮跑走了 · 浮出消息按屏幕三分之一右对齐",
  },
  render: (a) => {
    const px = W - 8 - PILL_W;
    return frame(
      a,
      `<div class="ghost">${bar(BX, BY, PW)}</div>
      ${pill(px, BY)}
      ${float(BX - 40, H - BY + 12, PW + 40, "right")}
      ${CURSOR(BX + 26, BY + 30)}
      ${arrow(BX + 50, BY + 23, px - 10, BY + 23, "oklch(0.62 0.22 27)", true)}
      ${box(BX - 46, 738, PW + 52, 102)}
      ${an(700, 640, "① 浮出的消息看屏幕右侧三分之一来定 → 右对齐")}
      ${an(700, 720, "② 收完后胶囊贴在右边，<br>原来鼠标下的「Li」按钮跑到右边去了")}
      ${arrow(1040, 760, BX + 22, BY + 6)}
      ${an(24, 300, "另：展开后所有消息都靠左，<br>不分你和 Li", "info")}`,
    );
  },
};

/** 1 Expanded: as today. */
export const F1Expanded: Story = {
  args: { n: "1", caption: "展开：和现在一样", note: "最小化按钮 =「Li」，在输入条左边" },
  render: (a) =>
    frame(
      a,
      `<div class="w-panel" style="left:${BX}px;top:430px;width:${PW}px;height:${BY - 430 - 8}px"></div>
      ${log(BX + 10, H - BY + 18, PW - 20)}
      ${bar(BX, BY, PW)}
      ${CURSOR(BX + 26, BY + 30)}
      ${box(BX - 6, BY - 6, 48, 58, "good")}
      ${an(760, 800, "点左边的「Li」= 最小化", "good")}
      ${arrow(1020, 822, BX - 10, BY + 22, GOOD)}`,
    ),
};

/** 2 Pill: folds left, the button stays under the cursor; floating lines from the pill's side. */
export const F2Pill: Story = {
  args: {
    n: "2",
    caption: "胶囊：往左收，按钮留在原地",
    note: "浮出消息跟着胶囊对齐，不看屏幕三分之一",
  },
  render: (a) =>
    frame(
      a,
      `<div class="ghost">${bar(BX, BY, PW)}</div>
      ${pill(BX, BY)}
      ${float(BX, H - BY + 12, PW, "left")}
      ${CURSOR(BX + 26, BY + 30)}
      ${arrow(BX + 305, BY + 23, BX + PILL_W + 14, BY + 23, GOOD, true)}
      ${box(BX - 6, 738, PW + 12, 102, "good")}
      ${an(780, 720, "消息和胶囊的左边对齐", "good")}
      ${an(700, 790, "「Li」还在鼠标下，再点一下原地展开", "good")}
      ${arrow(1000, 838, BX - 8, BY + 22, GOOD)}`,
    ),
};

/** 2→3: the same button, on the pill, now reads as a tuck arrow. */
export const F2bTuckArrow: Story = {
  args: {
    n: "2→3",
    caption: "同一个按钮变成「收进边」箭头",
    note: "不加新按钮 · 也可以直接把胶囊拖到边上",
  },
  render: (a) =>
    frame(
      a,
      `${pill(BX, BY, { tuck: "right" })}
      ${float(BX, H - BY + 12, PW, "left")}
      ${CURSOR(BX + 26, BY + 30)}
      ${arrow(BX + PILL_W + 10, BY + 23, W - 22, BY + 23, INFO, true)}
      ${an(640, 760, "胶囊状态下，「Li」悬停 / 再点 → 箭头 ⇥<br>Li 滑进最近的屏幕边", "info")}
      ${arrow(970, 820, BX - 8, BY + 22, INFO)}`,
    ),
};

/** 3 Tucked: only a small handle on the edge. */
export const F3Tucked: Story = {
  args: {
    n: "3",
    caption: "收进边上：只露一个小把手",
    note: "页面完全不被挡 · 点把手，或按住把手拖出 → 回到胶囊",
  },
  render: (a) =>
    frame(
      a,
      `<div class="ghost">${pill(BX, BY)}</div>
      ${arrow(BX + PILL_W + 8, BY + 23, W - 24, BY + 23, INFO, true)}
      ${handle("right", HY)}
      ${box(W - 26, HY - 12, 30, 88, "good")}
      ${an(1060, 640, "小把手（贴着右边）", "good")}
      ${arrow(1260, 690, W - 30, HY + 4, GOOD)}`,
    ),
};

/** 3 Tucked + a new message: a dot, and the first line peeks out. */
export const F3Peek: Story = {
  args: {
    n: "3'",
    caption: "收起时来了新消息：亮点 + 露出第一行",
    note: "几秒后缩回把手，点就回到胶囊",
  },
  render: (a) =>
    frame(
      a,
      `${handle("right", HY)}
      <div class="w-dot" style="left:${W - 20}px;top:${HY - 8}px"></div>
      <div class="w-peek" style="left:${W - 14 - 380}px;top:${HY + 12}px;width:380px;border-radius:12px 0 0 12px;border-right:none">
        <div class="w-mark" style="width:24px;height:24px;font-size:11px">Li</div>复习完了，12 个词全对 ✓ 要开始读吗？</div>
      ${an(1000, 640, "红点 = 有未读", "good")}
      ${arrow(1140, 685, W - 22, HY - 8, GOOD)}
      ${an(700, 800, "第一行从边上探出来", "good")}
      ${arrow(930, 815, W - 400, HY + 34, GOOD)}`,
    ),
};

/** Dragging the pill toward the left edge. */
export const F4Drag: Story = {
  args: { n: "4", caption: "拖到左边：最近的边会亮起来", note: "放手就贴到那一边" },
  render: (a) =>
    frame(
      a,
      `<div class="ghost">${pill(BX, BY)}</div>
      ${pill(170, BY - 120)}
      ${CURSOR(196, BY - 90)}
      ${arrow(BX - 10, BY + 10, 320, BY - 100, INFO, true)}
      <div style="position:absolute;left:0;top:0;width:6px;height:${H}px;background:linear-gradient(oklch(0.58 0.17 260 / 0),oklch(0.58 0.17 260 / 0.9),oklch(0.58 0.17 260 / 0))"></div>
      ${an(40, 560, "左边缘亮起 = 会吸附到左边", "info")}`,
    ),
};

/** On the left, everything mirrors. */
export const F5LeftMirror: Story = {
  args: {
    n: "5",
    caption: "在左边：整套镜像",
    note: "按钮在内侧（右）· 往右收 · 消息贴着胶囊 · 收进左边",
  },
  render: (a) => {
    const lx = 8;
    return frame(
      a,
      `<div class="ghost">${bar(lx, BY, PW, { markFirst: false })}</div>
      ${pill(lx + PW - PILL_W, BY, { mirror: true })}
      ${float(lx, H - BY + 12, PW, "right")}
      ${CURSOR(lx + PW - 16, BY + 30)}
      ${arrow(lx + 18, BY + 23, lx + PW - PILL_W - 14, BY + 23, GOOD, true)}
      ${handle("left", BY - 120)}
      <div class="w-dot" style="left:6px;top:${BY - 128}px"></div>
      ${an(380, 650, "镜像：浮出消息和胶囊右边对齐", "good")}
      ${an(380, 790, "「Li」按钮在内侧，还是在鼠标下", "good")}
      ${arrow(372, 812, lx + PW + 6, BY + 22, GOOD)}
      ${an(60, 600, "收进左边后的把手", "info")}
      ${arrow(110, 650, 22, BY - 96, INFO)}`,
    );
  },
};

/** Li above the full-screen /read word review; the wheel over the input scrolls the history (#506). */
export const F6ReadReview: Story = {
  args: {
    n: "6",
    caption: "/read 复习全屏时，Li 在它上面",
    note: "#506：滚轮在输入框上 = 滚动聊天记录",
  },
  render: (a) =>
    frame(
      a,
      `${REVIEW}
      <div class="w-panel" style="left:${BX}px;top:470px;width:${PW}px;height:${BY - 470 - 8}px"></div>
      ${log(BX + 10, H - BY + 18, PW - 20, "left", true)}
      ${bar(BX, BY, PW)}
      <svg class="arw" style="left:${BX + 150}px;top:${BY - 4}px" width="28" height="54" viewBox="0 0 28 54"><rect x="3" y="3" width="22" height="34" rx="11" fill="oklch(0.98 0 0 / 0.9)" stroke="oklch(0.58 0.17 260)" stroke-width="2.5"/><line x1="14" y1="10" x2="14" y2="18" stroke="oklch(0.58 0.17 260)" stroke-width="3" stroke-linecap="round"/><path d="M8 44l6 7 6-7" fill="none" stroke="oklch(0.58 0.17 260)" stroke-width="2.5" stroke-linecap="round"/></svg>
      ${an(760, 520, "复习卡片在下面，Li 浮在最上层", "info")}
      ${an(760, 790, "鼠标在输入框上滚动 → 记录上下滚", "info")}
      ${arrow(1060, 812, BX + 140, BY + 16, INFO)}`,
      PAGE,
    ),
};

// ── phone (390×844): state 3 ───────────────────────────────────────────────
const PH = 844;
const PWD = 390;
const phoneTucked = (a: FrameArgs) =>
  frame(
    a,
    `${handle("right", PH - 150, PWD)}
    <div class="w-dot" style="left:${PWD - 20}px;top:${PH - 158}px"></div>
    <div class="w-peek" style="left:${PWD - 14 - 290}px;top:${PH - 138}px;width:290px;border-radius:12px 0 0 12px;border-right:none;font-size:14px">
      <div class="w-mark" style="width:22px;height:22px;font-size:10px">Li</div>复习完了，要开始读吗？</div>
    ${an(130, PH - 250, "手机同一套：把手 + 亮点 + 第一行", "good")}
    ${an(20, PH - 70, "点把手 / 按住把手拖出 → 回到胶囊", "info")}`,
    PAGE_PHONE,
  );

export const P3PhoneTucked: Story = {
  args: {
    n: "3 手机",
    caption: "收进边上（手机）",
    note: "390×844 · 新消息探出第一行",
    device: "phone",
  },
  render: phoneTucked,
};

// ── dark variants of the key frames ────────────────────────────────────────
export const F2PillDark: Story = {
  ...F2Pill,
  args: { ...F2Pill.args, theme: "dark", caption: "胶囊（深色）" },
};
export const F3PeekDark: Story = {
  ...F3Peek,
  args: { ...F3Peek.args, theme: "dark", caption: "新消息探出（深色）" },
};
export const P3PhoneTuckedDark: Story = {
  ...P3PhoneTucked,
  args: { ...P3PhoneTucked.args, theme: "dark", caption: "收进边上（手机·深色）" },
};
