"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import type { RoadmapNodeProgress } from "@/types/roadmap";
import { fill } from "@/lib/roadmap/labels";

type Props = {
  nodes: RoadmapNodeProgress[];
  overallMaturityRate: number;
  /** Translated strings (dictionary `roadmap-page`); `{mature}`, `{total}`, `{pct}` filled here. */
  labels: { cardsCount: string; noCards: string; overallProgress: string };
};

const NODE_W = 180;
const NODE_H = 80;
const H_GAP = 40;
const V_GAP = 20;
const RADIUS = 16;

/** How many cards fit across `width` (at least one). */
function columnsFor(width: number, count: number): number {
  const fit = Math.floor((width - H_GAP) / (NODE_W + H_GAP));
  return Math.max(1, Math.min(count, fit));
}

// Colours are the theme's oklch tokens (app/globals.css), switched for dark
// mode by the wrapper's custom properties below — never hex.
const C = {
  card: "var(--rm-card)",
  cardBorder: "var(--rm-border)",
  track: "var(--rm-track)",
  text: "var(--rm-text)",
  muted: "var(--rm-muted)",
  done: "var(--color-green-600)",
  doneBg: "var(--rm-done-bg)",
  partial: "var(--color-yellow-500)",
  partialBg: "var(--rm-partial-bg)",
  overall: "var(--color-blue-600)",
};

export default function RoadmapD3({ nodes, overallMaturityRate, labels }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);

  // The map fits the pane: columns follow its width, so no step is cut off.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0 || width === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const cols = columnsFor(width, nodes.length);
    const rows = Math.ceil(nodes.length / cols);
    const gridW = cols * (NODE_W + H_GAP) + H_GAP;
    const svgW = Math.max(gridW, width);
    const left = Math.floor((svgW - gridW) / 2);
    const height = rows * (NODE_H + V_GAP) + V_GAP + 60;

    svg.attr("width", svgW).attr("height", height).attr("viewBox", `0 0 ${svgW} ${height}`);

    const sorted = [...nodes].sort((a, b) => a.order - b.order);
    const at = (i: number) => ({
      x: left + H_GAP + (i % cols) * (NODE_W + H_GAP),
      y: V_GAP + Math.floor(i / cols) * (NODE_H + V_GAP),
    });

    // Connector lines between consecutive steps
    const lineG = svg.append("g").attr("class", "lines");
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = at(i);
      const b = at(i + 1);
      lineG
        .append("line")
        .attr("x1", a.x + NODE_W / 2)
        .attr("y1", a.y + NODE_H / 2)
        .attr("x2", b.x + NODE_W / 2)
        .attr("y2", b.y + NODE_H / 2)
        .attr("stroke", C.cardBorder)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "4 4");
    }

    const nodeG = svg
      .selectAll("g.node")
      .data(sorted)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", (_, i) => `translate(${at(i).x},${at(i).y})`);

    nodeG
      .append("rect")
      .attr("width", NODE_W)
      .attr("height", NODE_H)
      .attr("rx", 10)
      .attr("fill", (d) =>
        d.maturityRate >= 1 ? C.doneBg : d.maturityRate > 0 ? C.partialBg : C.card,
      )
      .attr("stroke", (d) =>
        d.maturityRate >= 1 ? C.done : d.maturityRate > 0 ? C.partial : C.cardBorder,
      )
      .attr("stroke-width", 1.5);

    nodeG
      .append("rect")
      .attr("x", 8)
      .attr("y", NODE_H - 14)
      .attr("width", NODE_W - 16)
      .attr("height", 6)
      .attr("rx", 3)
      .attr("fill", C.track);

    nodeG
      .append("rect")
      .attr("x", 8)
      .attr("y", NODE_H - 14)
      .attr("width", 0)
      .attr("height", 6)
      .attr("rx", 3)
      .attr("fill", (d) => (d.maturityRate >= 1 ? C.done : C.partial))
      .transition()
      .duration(800)
      .delay((_, i) => i * 80)
      .attr("width", (d) => (NODE_W - 16) * d.maturityRate);

    nodeG
      .append("circle")
      .attr("cx", NODE_W - RADIUS - 6)
      .attr("cy", RADIUS + 4)
      .attr("r", RADIUS)
      .attr("fill", C.card)
      .attr("stroke", (d) => (d.maturityRate >= 1 ? C.done : C.cardBorder))
      .attr("stroke-width", 1.5);

    nodeG
      .append("text")
      .attr("x", NODE_W - RADIUS - 6)
      .attr("y", RADIUS + 4)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", 9)
      .attr("fill", C.text)
      .text((d) => `${Math.round(d.maturityRate * 100)}%`);

    nodeG
      .append("foreignObject")
      .attr("x", 8)
      .attr("y", 6)
      .attr("width", NODE_W - RADIUS * 2 - 18)
      .attr("height", NODE_H - 26)
      .append("xhtml:div")
      .style("font-size", "11px")
      .style("font-weight", "600")
      .style("color", C.text)
      .style("line-height", "1.3")
      .style("overflow", "hidden")
      .style("display", "-webkit-box")
      .style("-webkit-line-clamp", "2")
      .style("-webkit-box-orient", "vertical")
      .text((d) => d.title);

    nodeG
      .append("text")
      .attr("x", 8)
      .attr("y", NODE_H - 18)
      .attr("font-size", 9)
      .attr("fill", C.muted)
      .text((d) =>
        d.totalCards > 0
          ? fill(labels.cardsCount, { mature: d.matureCards, total: d.totalCards })
          : labels.noCards,
      );

    const barY = height - 36;
    const barX = left + H_GAP;
    const barW = gridW - 2 * H_GAP;
    svg
      .append("text")
      .attr("x", barX)
      .attr("y", barY - 8)
      .attr("font-size", 12)
      .attr("font-weight", "600")
      .attr("fill", C.text)
      .text(fill(labels.overallProgress, { pct: Math.round(overallMaturityRate * 100) }));

    svg
      .append("rect")
      .attr("x", barX)
      .attr("y", barY)
      .attr("width", barW)
      .attr("height", 10)
      .attr("rx", 5)
      .attr("fill", C.track);

    svg
      .append("rect")
      .attr("x", barX)
      .attr("y", barY)
      .attr("width", 0)
      .attr("height", 10)
      .attr("rx", 5)
      .attr("fill", overallMaturityRate >= 1 ? C.done : C.overall)
      .transition()
      .duration(1000)
      .attr("width", barW * overallMaturityRate);
  }, [
    nodes,
    overallMaturityRate,
    labels.cardsCount,
    labels.noCards,
    labels.overallProgress,
    width,
  ]);

  return (
    <div
      ref={wrapRef}
      className="overflow-x-auto [--rm-card:var(--color-white)] [--rm-border:var(--color-gray-300)] [--rm-track:var(--color-gray-200)] [--rm-text:var(--color-gray-800)] [--rm-muted:var(--color-gray-500)] [--rm-done-bg:var(--color-green-100)] [--rm-partial-bg:var(--color-yellow-100)] dark:[--rm-card:var(--color-gray-900)] dark:[--rm-border:var(--color-gray-700)] dark:[--rm-track:var(--color-gray-800)] dark:[--rm-text:var(--color-gray-100)] dark:[--rm-muted:var(--color-gray-400)] dark:[--rm-done-bg:var(--color-green-950)] dark:[--rm-partial-bg:var(--color-yellow-950)]"
    >
      <svg ref={svgRef} className="block" />
    </div>
  );
}
