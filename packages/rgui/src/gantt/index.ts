/**
 * rgui gantt — a Gantt chart's pure parts on rgui's algorithms: time scales
 * (linear and symmetric-log, unit lengths from lane/temporal), readable-grid
 * tick choice (core/grid readableStep), and semantic-zoom LOD that folds
 * unreadable rows into cluster pseudo-rows (core/rule, lane/treefold).
 * No renderer: the host draws (Lianki: DOM, windowed). Import it as
 * "@snomiao/rgui/gantt"; it pulls in none of the Canvas/WebGPU code.
 */
export * from "./scale";
export * from "./ticks";
export * from "./layout";
