import type { Meta, StoryObj } from "@storybook/html";

/**
 * Storyboard for the Li chat widget's fold redesign (packages/debug-chat).
 * Static mocks, not the live component: each story is one frame of the story
 * the owner reviews — today's misalignment, then expanded → pill → tucked into
 * the screen edge, a new message peeking from the tucked handle, dragging to
 * the left edge (everything mirrors), and Li above the /read review.
 * Colours are oklch only; the paper/ink tokens follow app/globals.css.
 */

type Theme = "light" | "dark";
type Device = "desktop" | "phone";
type Side = "right" | "left";

interface FrameArgs {
  n: string;
  caption: string;
  note?: string;
  theme: Theme;
  device: Device;
}

const SIZE: Record<Device, { w: number; h: number }> = {
  desktop: { w: 1440, h: 900 },
  phone: { w: 390, h: 844 },
};

const CSS = `
.cf { --brand: oklch(0.53 0.207 22.3); --background: oklch(0.945 0.02 82); --foreground: oklch(0.22 0.015 65);
  --muted: oklch(0.5 0.02 65); --line: oklch(0.22 0.015 65 / 0.12); --glass: oklch(0.985 0.01 82 / 0.82);
  --glass-solid: oklch(0.975 0.012 82); --shadow: 0 6px 24px oklch(0.3 0.03 60 / 0.18);
  --ok: oklch(0.68 0.16 150); --warn: oklch(0.62 0.22 27); --note: oklch(0.55 0.2 260); --mine: oklch(0.92 0.06 90 / 0.75);
  --card: oklch(0.975 0.012 82); font-family: system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif; color: var(--foreground);
  display: inline-block; background: oklch(0.88 0.01 80); padding: 0; }
.cf[data-theme="dark"] { --brand: oklch(0.6 0.205 18.3); --background: oklch(0.18 0.01 65); --foreground: oklch(0.92 0.02 82);
  --muted: oklch(0.68 0.015 70); --line: oklch(0.92 0.02 82 / 0.12); --glass: oklch(0.24 0.012 65 / 0.82);
  --glass-solid: oklch(0.25 0.012 65); --shadow: 0 6px 24px oklch(0 0 0 / 0.45); --mine: oklch(0.36 0.05 250 / 0.75);
  --note: oklch(0.72 0.15 260); --card: oklch(0.23 0.012 65); background: oklch(0.12 0.01 65); }
.cf * { box-sizing: border-box; }
.cf-cap { display: flex; align-items: baseline; gap: 14px; padding: 14px 22px; background: var(--foreground); color: var(--background); }
.cf-cap b { font-size: 26px; font-weight: 700; color: var(--brand); filter: brightness(1.25); }
.cf-cap span { font-size: 24px; font-weight: 600; }
.cf-cap i { font-style: normal; font-size: 17px; opacity: 0.75; margin-left: auto; }
.cf-phone .cf-cap { flex-wrap: wrap; gap: 6px 10px; padding: 12px 14px; }
.cf-phone .cf-cap span { font-size: 19px; } .cf-phone .cf-cap b { font-size: 20px; }
.cf-phone .cf-cap i { margin-left: 0; font-size: 14px; width: 100%; }
.cf-screen { position: relative; overflow: hidden; background: var(--background); }
/* the page underneath */
.pg-top { height: 56px; display: flex; align-items: center; gap: 22px; padding: 0 28px; border-bottom: 1px solid var(--line); font-size: 15px; color: var(--muted); }
.pg-top .logo { width: 30px; height: 30px; border-radius: 7px; background: var(--brand); color: oklch(0.98 0.01 82); display: grid; place-items: center; font-weight: 700; font-size: 16px; }
.pg-body { padding: 48px 0 0 0; margin: 0 auto; width: 720px; }
.pg-body h1 { font-size: 34px; margin: 0 0 18px; font-family: Georgia, "Songti SC", serif; font-weight: 600; }
.pg-body p { font-size: 19px; line-height: 1.75; margin: 0 0 18px; color: var(--foreground); opacity: 0.86; font-family: Georgia, serif; }
.pg-body mark { background: oklch(0.9 0.09 90 / 0.8); color: inherit; border-radius: 3px; padding: 0 2px; }
.cf[data-theme="dark"] .pg-body mark { background: oklch(0.42 0.08 90 / 0.8); }
.cf-phone .pg-top { height: 48px; padding: 0 14px; gap: 12px; font-size: 13px; }
.cf-phone .pg-body { width: auto; padding: 22px 18px 0; }
.cf-phone .pg-body h1 { font-size: 24px; } .cf-phone .pg-body p { font-size: 16px; }
/* widget */
.w-bar { position: absolute; height: 46px; border-radius: 23px; background: var(--glass); backdrop-filter: blur(10px);
  box-shadow: var(--shadow); border: 1px solid var(--line); display: flex; align-items: center; gap: 8px; padding: 0 6px; }
.w-mark { width: 34px; height: 34px; border-radius: 50%; background: var(--brand); color: oklch(0.98 0.01 82); flex: none;
  display: grid; place-items: center; font: 700 14px Georgia, serif; position: relative; }
.w-input { flex: 1; height: 34px; border-radius: 17px; background: oklch(from var(--background) l c h / 0.55); padding: 0 14px;
  display: flex; align-items: center; font-size: 15px; color: var(--muted); }
.w-mic { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); flex: none; }
.w-conn { display: flex; gap: 4px; padding: 0 4px; } .w-conn u { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.w-conn u:nth-child(2) { background: oklch(0.75 0.13 75); }
.w-log { position: absolute; display: flex; flex-direction: column; gap: 8px; }
.w-msg { max-width: 100%; padding: 9px 13px; border-radius: 14px; background: var(--glass); border: 1px solid var(--line);
  box-shadow: var(--shadow); font-size: 15px; line-height: 1.45; backdrop-filter: blur(10px); }
.w-msg.me { background: var(--mine); }
.w-msg small { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.w-panel { position: absolute; border-radius: 18px; background: var(--glass); border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: blur(10px); }
.w-float { position: absolute; display: flex; flex-direction: column; gap: 6px; }
.w-float .w-msg { padding: 6px 11px; font-size: 14px; }
.w-handle { position: absolute; width: 14px; height: 64px; background: var(--glass-solid); border: 1px solid var(--line);
  box-shadow: var(--shadow); display: grid; place-items: center; }
.w-handle::before { content: ""; width: 3px; height: 26px; border-radius: 2px; background: var(--brand); opacity: 0.85; }
.w-dot { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: var(--warn); border: 2px solid var(--background); }
.w-peek { position: absolute; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: var(--glass-solid);
  border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 15px; white-space: nowrap; }
.ghost { position: absolute; inset: 0; opacity: 0.5; filter: grayscale(0.7); pointer-events: none; }
.ghost .w-bar { border: 2px dashed var(--muted); box-shadow: none; }
/* annotations */
.an { position: absolute; padding: 8px 12px; border-radius: 10px; font-size: 17px; font-weight: 600; line-height: 1.4;
  background: oklch(0.98 0.03 25); color: oklch(0.42 0.17 25); border: 2px solid oklch(0.62 0.22 27); max-width: 330px; }
.an.good { background: oklch(0.97 0.04 150); color: oklch(0.38 0.11 150); border-color: oklch(0.6 0.15 150); }
.an.info { background: oklch(0.97 0.03 260); color: oklch(0.38 0.15 260); border-color: oklch(0.58 0.17 260); }
.cf[data-theme="dark"] .an { background: oklch(0.28 0.06 25); color: oklch(0.88 0.08 25); }
.cf[data-theme="dark"] .an.good { background: oklch(0.27 0.05 150); color: oklch(0.88 0.08 150); }
.cf[data-theme="dark"] .an.info { background: oklch(0.27 0.05 260); color: oklch(0.88 0.08 260); }
.box { position: absolute; border: 2.5px dashed oklch(0.62 0.22 27); border-radius: 12px; }
.box.good { border-color: oklch(0.6 0.15 150); } .box.info { border-color: oklch(0.58 0.17 260); }
.cf-phone .an { font-size: 14px; max-width: 220px; padding: 6px 9px; }
svg.arw { position: absolute; overflow: visible; pointer-events: none; }
.cursor { position: absolute; width: 22px; height: 22px; }
/* /read review */
.rv { position: absolute; inset: 0; background: oklch(from var(--background) calc(l - 0.02) c h); display: flex; flex-direction: column; align-items: center; padding-top: 110px; }
.rv-card { width: 620px; padding: 44px 48px; border-radius: 22px; background: var(--card); box-shadow: var(--shadow); border: 1px solid var(--line); text-align: center; }
.rv-card .w { font: 600 54px Georgia, serif; } .rv-card .ipa { color: var(--muted); font-size: 20px; margin: 6px 0 20px; }
.rv-card .ctx { font: 19px/1.7 Georgia, serif; opacity: 0.85; } .rv-card .ctx b { color: var(--brand); }
.rv-rate { display: flex; gap: 14px; margin-top: 30px; }
.rv-rate div { width: 132px; padding: 12px 0; text-align: center; border-radius: 12px; border: 1px solid var(--line); background: var(--card); font-size: 17px; }
.rv-rate small { display: block; color: var(--muted); font-size: 13px; }
.rv-prog { position: absolute; top: 34px; left: 50%; transform: translateX(-50%); width: 420px; height: 6px; border-radius: 3px; background: var(--line); }
.rv-prog::after { content: ""; display: block; width: 58%; height: 100%; border-radius: 3px; background: var(--brand); }
`;

const MIC = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const TUCK = (dir: Side) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:${dir === "left" ? "scaleX(-1)" : "none"}"><path d="M5 12h11M11 6l6 6-6 6M20 4v16"/></svg>`;
const CURSOR = (x: number, y: number, ghost = false) =>
  `<svg class="cursor" style="left:${x}px;top:${y}px;${ghost ? "opacity:.35" : ""}" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-8L21 10z" fill="oklch(0.2 0 0)" stroke="oklch(0.98 0 0)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/** A straight arrow from (x1,y1) to (x2,y2), drawn in screen px. */
const arrow = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tone = "oklch(0.62 0.22 27)",
  dash = false,
) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 14;
  const p1 = `${x2 - h * Math.cos(a - 0.45)},${y2 - h * Math.sin(a - 0.45)}`;
  const p2 = `${x2 - h * Math.cos(a + 0.45)},${y2 - h * Math.sin(a + 0.45)}`;
  return `<svg class="arw" style="left:0;top:0" width="1" height="1"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${tone}" stroke-width="3.5" ${dash ? 'stroke-dasharray="9 7"' : ""} stroke-linecap="round"/><polygon points="${x2},${y2} ${p1} ${p2}" fill="${tone}"/></svg>`;
};
const GOOD = "oklch(0.6 0.15 150)";
const INFO = "oklch(0.58 0.17 260)";

const an = (x: number, y: number, text: string, tone: "" | "good" | "info" = "") =>
  `<div class="an ${tone}" style="left:${x}px;top:${y}px">${text}</div>`;
const box = (x: number, y: number, w: number, h: number, tone: "" | "good" | "info" = "") =>
  `<div class="box ${tone}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;

// ── the page under the widget ──────────────────────────────────────────────

const PAGE = `
<div class="pg-top"><div class="logo">L</div><span>Lianki</span><span>/words</span><span>/read</span><span style="margin-left:auto">设置</span></div>
<div class="pg-body">
  <h1>The Quiet Harbour</h1>
  <p>The fishing boats came back before the <mark>tide</mark> turned, their hulls low with the morning's catch. Along the
  <mark>quay</mark>, gulls argued over scraps while the harbour master counted the moorings one by one.</p>
  <p>Nobody hurried. The town had learned long ago that the sea keeps its own <mark>schedule</mark>, and that a day spent
  waiting is rarely a day wasted. Old nets hung drying in the sun, mended in a dozen colours.</p>
  <p>By noon the market stalls were full: silver sardines, a basket of <mark>whelks</mark>, crabs still clicking in
  their crates. Children ran between the tables, chasing a dog that had stolen a fish.</p>
  <p>In the afternoon the wind dropped, and the water went as flat and grey as a slate roof.</p>
</div>`;

const PAGE_PHONE = `
<div class="pg-top"><div class="logo" style="width:26px;height:26px;font-size:14px">L</div><span>/read</span><span style="margin-left:auto">设置</span></div>
<div class="pg-body">
  <h1>The Quiet Harbour</h1>
  <p>The fishing boats came back before the <mark>tide</mark> turned, their hulls low with the morning's catch. Along the
  <mark>quay</mark>, gulls argued over scraps while the harbour master counted the moorings.</p>
  <p>Nobody hurried. The town had learned long ago that the sea keeps its own <mark>schedule</mark>, and that a day spent
  waiting is rarely a day wasted.</p>
  <p>By noon the market stalls were full: silver sardines, a basket of <mark>whelks</mark>, crabs still clicking in their crates.</p>
</div>`;

const REVIEW = `
<div class="rv"><div class="rv-prog"></div>
  <div class="rv-card"><div class="w">quay</div><div class="ipa">/kiː/ · noun</div>
    <div class="ctx">Along the <b>quay</b>, gulls argued over scraps while the harbour master counted the moorings.</div></div>
  <div class="rv-rate"><div>重来<small>1 分钟</small></div><div>困难<small>6 分钟</small></div><div>良好<small>1 天</small></div><div>简单<small>4 天</small></div></div>
</div>`;

// ── widget pieces (screen px) ──────────────────────────────────────────────

const LOG = [
  { me: true, t: "今天先复习，再读一篇短文" },
  { me: false, t: "好。今天到期 12 个词，大约 6 分钟。复习完我把《The Quiet Harbour》打开。" },
  { me: true, t: "quay 怎么读？" },
  { me: false, t: "quay 读 /kiː/，和 key 同音。" },
];

const bar = (x: number, y: number, w: number, opts: { tuck?: Side; markFirst?: boolean } = {}) => {
  const mark = `<div class="w-mark">${opts.tuck ? TUCK(opts.tuck) : "Li"}</div>`;
  const parts = [mark, `<div class="w-input">和 Li 说…</div>`, `<div class="w-mic">${MIC}</div>`];
  if (opts.markFirst === false) parts.reverse();
  return `<div class="w-bar" style="left:${x}px;top:${y}px;width:${w}px">${parts.join("")}</div>`;
};

/** The pill: [mark | connections | mic], or mirrored. */
const pill = (x: number, y: number, opts: { tuck?: Side; mirror?: boolean; cls?: string } = {}) => {
  const mark = `<div class="w-mark">${opts.tuck ? TUCK(opts.tuck) : "Li"}</div>`;
  const parts = [
    mark,
    `<div class="w-conn"><u></u><u></u></div>`,
    `<div class="w-mic">${MIC}</div>`,
  ];
  if (opts.mirror) parts.reverse();
  return `<div class="w-bar ${opts.cls ?? ""}" style="left:${x}px;top:${y}px;width:128px">${parts.join("")}</div>`;
};
const PILL_W = 128;

const log = (
  x: number,
  bottom: number,
  w: number,
  align: "left" | "right" = "left",
  small = false,
) =>
  `<div class="w-log" style="left:${x}px;bottom:${bottom}px;width:${w}px;align-items:${align === "left" ? "flex-start" : "flex-end"}">${LOG.map(
    (m) =>
      `<div class="w-msg ${m.me ? "me" : ""}" style="${small ? "font-size:14px;padding:7px 11px" : ""}"><small>${m.me ? "你" : "Li"}</small>${m.t}</div>`,
  ).join("")}</div>`;

const float = (x: number, bottom: number, w: number, align: "left" | "right") =>
  `<div class="w-float" style="left:${x}px;bottom:${bottom}px;width:${w}px;align-items:${align === "left" ? "flex-start" : "flex-end"}">
    <div class="w-msg">复习完了，12 个词全对 ✓</div><div class="w-msg">要开始读《The Quiet Harbour》吗？</div></div>`;

// ── desktop geometry: 20rem panel, 8px gutter ──────────────────────────────
const W = 1440;
const H = 900;
const PW = 320;
const BX = W - 8 - PW; // 1112
const BY = H - 8 - 46; // 846
const HY = BY - 70; // the tucked handle's top

const handle = (side: Side, y: number, vw = W) =>
  `<div class="w-handle" style="${side === "right" ? `left:${vw - 14}px;border-radius:10px 0 0 10px;border-right:none` : "left:0;border-radius:0 10px 10px 0;border-left:none"};top:${y}px"></div>`;

// ── frame shell ────────────────────────────────────────────────────────────

const frame = (args: FrameArgs, inner: string, page = PAGE) => {
  const { w, h } = SIZE[args.device];
  const el = document.createElement("div");
  el.className = `cf ${args.device === "phone" ? "cf-phone" : ""}`;
  el.dataset.theme = args.theme;
  el.id = "frame";
  el.style.width = `${w}px`;
  el.innerHTML = `<style>${CSS}</style>
    <div class="cf-cap"><b>${args.n}</b><span>${args.caption}</span>${args.note ? `<i>${args.note}</i>` : ""}</div>
    <div class="cf-screen" style="width:${w}px;height:${h}px">${page}${inner}</div>`;
  return el;
};

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
    note: "页面完全不被挡 · 点把手或从边缘往里拉 → 回到胶囊",
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
    ${an(20, PH - 70, "从右边缘往里拉 → 回到胶囊", "info")}`,
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
