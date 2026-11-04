/** Shared pieces of the chat-fold storyboard mocks (static HTML, oklch colours). */

export type Theme = "light" | "dark";
export type Device = "desktop" | "phone";
export type Side = "right" | "left";

export interface FrameArgs {
  n: string;
  caption: string;
  note?: string;
  theme: Theme;
  device: Device;
}

export const SIZE: Record<Device, { w: number; h: number }> = {
  desktop: { w: 1440, h: 900 },
  phone: { w: 390, h: 844 },
};

export const CSS = `
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

export const MIC = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
export const TUCK = (dir: Side) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="transform:${dir === "left" ? "scaleX(-1)" : "none"}"><path d="M5 12h11M11 6l6 6-6 6M20 4v16"/></svg>`;
export const CURSOR = (x: number, y: number, ghost = false) =>
  `<svg class="cursor" style="left:${x}px;top:${y}px;${ghost ? "opacity:.35" : ""}" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-8L21 10z" fill="oklch(0.2 0 0)" stroke="oklch(0.98 0 0)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/** A straight arrow from (x1,y1) to (x2,y2), drawn in screen px. */
export const arrow = (
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
export const GOOD = "oklch(0.6 0.15 150)";
export const INFO = "oklch(0.58 0.17 260)";

export const an = (x: number, y: number, text: string, tone: "" | "good" | "info" = "") =>
  `<div class="an ${tone}" style="left:${x}px;top:${y}px">${text}</div>`;
export const box = (x: number, y: number, w: number, h: number, tone: "" | "good" | "info" = "") =>
  `<div class="box ${tone}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;

// ── the page under the widget ──────────────────────────────────────────────

export const PAGE = `
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

export const PAGE_PHONE = `
<div class="pg-top"><div class="logo" style="width:26px;height:26px;font-size:14px">L</div><span>/read</span><span style="margin-left:auto">设置</span></div>
<div class="pg-body">
  <h1>The Quiet Harbour</h1>
  <p>The fishing boats came back before the <mark>tide</mark> turned, their hulls low with the morning's catch. Along the
  <mark>quay</mark>, gulls argued over scraps while the harbour master counted the moorings.</p>
  <p>Nobody hurried. The town had learned long ago that the sea keeps its own <mark>schedule</mark>, and that a day spent
  waiting is rarely a day wasted.</p>
  <p>By noon the market stalls were full: silver sardines, a basket of <mark>whelks</mark>, crabs still clicking in their crates.</p>
</div>`;

export const REVIEW = `
<div class="rv"><div class="rv-prog"></div>
  <div class="rv-card"><div class="w">quay</div><div class="ipa">/kiː/ · noun</div>
    <div class="ctx">Along the <b>quay</b>, gulls argued over scraps while the harbour master counted the moorings.</div></div>
  <div class="rv-rate"><div>重来<small>1 分钟</small></div><div>困难<small>6 分钟</small></div><div>良好<small>1 天</small></div><div>简单<small>4 天</small></div></div>
</div>`;

// ── widget pieces (screen px) ──────────────────────────────────────────────

export const LOG = [
  { me: true, t: "今天先复习，再读一篇短文" },
  { me: false, t: "好。今天到期 12 个词，大约 6 分钟。复习完我把《The Quiet Harbour》打开。" },
  { me: true, t: "quay 怎么读？" },
  { me: false, t: "quay 读 /kiː/，和 key 同音。" },
];

export const bar = (
  x: number,
  y: number,
  w: number,
  opts: { tuck?: Side; markFirst?: boolean } = {},
) => {
  const mark = `<div class="w-mark">${opts.tuck ? TUCK(opts.tuck) : "Li"}</div>`;
  const parts = [mark, `<div class="w-input">和 Li 说…</div>`, `<div class="w-mic">${MIC}</div>`];
  if (opts.markFirst === false) parts.reverse();
  return `<div class="w-bar" style="left:${x}px;top:${y}px;width:${w}px">${parts.join("")}</div>`;
};

/** The pill: [mark | connections | mic], or mirrored. */
export const pill = (
  x: number,
  y: number,
  opts: { tuck?: Side; mirror?: boolean; cls?: string } = {},
) => {
  const mark = `<div class="w-mark">${opts.tuck ? TUCK(opts.tuck) : "Li"}</div>`;
  const parts = [
    mark,
    `<div class="w-conn"><u></u><u></u></div>`,
    `<div class="w-mic">${MIC}</div>`,
  ];
  if (opts.mirror) parts.reverse();
  return `<div class="w-bar ${opts.cls ?? ""}" style="left:${x}px;top:${y}px;width:128px">${parts.join("")}</div>`;
};
export const PILL_W = 128;

export const log = (
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

export const float = (x: number, bottom: number, w: number, align: "left" | "right") =>
  `<div class="w-float" style="left:${x}px;bottom:${bottom}px;width:${w}px;align-items:${align === "left" ? "flex-start" : "flex-end"}">
    <div class="w-msg">复习完了，12 个词全对 ✓</div><div class="w-msg">要开始读《The Quiet Harbour》吗？</div></div>`;

// ── desktop geometry: 20rem panel, 8px gutter ──────────────────────────────
export const W = 1440;
export const H = 900;
export const PW = 320;
export const BX = W - 8 - PW; // 1112
export const BY = H - 8 - 46; // 846
export const HY = BY - 70; // the tucked handle's top

export const handle = (side: Side, y: number, vw = W) =>
  `<div class="w-handle" style="${side === "right" ? `left:${vw - 14}px;border-radius:10px 0 0 10px;border-right:none` : "left:0;border-radius:0 10px 10px 0;border-left:none"};top:${y}px"></div>`;

// ── frame shell ────────────────────────────────────────────────────────────

export const frame = (args: FrameArgs, inner: string, page = PAGE) => {
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
