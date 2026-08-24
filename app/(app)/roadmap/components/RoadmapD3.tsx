"use client";

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { RoadmapNodeProgress } from "@/types/roadmap";

type Props = {
  nodes: RoadmapNodeProgress[];
  overallMaturityRate: number;
};

const NODE_W = 180;
const NODE_H = 80;
const H_GAP = 60;
const V_GAP = 20;
const RADIUS = 16;

export default function RoadmapD3({ nodes, overallMaturityRate }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const cols = Math.ceil(Math.sqrt(nodes.length));
    const rows = Math.ceil(nodes.length / cols);
    const width = cols * (NODE_W + H_GAP) + H_GAP;
    const height = rows * (NODE_H + V_GAP) + V_GAP + 60;

    svg.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);

    const sorted = [...nodes].sort((a, b) => a.order - b.order);

    // Draw connector lines between nodes
    const lineG = svg.append("g").attr("class", "lines");
    for (let i = 0; i < sorted.length - 1; i++) {
      const fromCol = i % cols;
      const fromRow = Math.floor(i / cols);
      const toCol = (i + 1) % cols;
      const toRow = Math.floor((i + 1) / cols);

      const x1 = H_GAP + fromCol * (NODE_W + H_GAP) + NODE_W / 2;
      const y1 = V_GAP + fromRow * (NODE_H + V_GAP) + NODE_H / 2;
      const x2 = H_GAP + toCol * (NODE_W + H_GAP) + NODE_W / 2;
      const y2 = V_GAP + toRow * (NODE_H + V_GAP) + NODE_H / 2;

      lineG
        .append("line")
        .attr("x1", x1)
        .attr("y1", y1)
        .attr("x2", x2)
        .attr("y2", y2)
        .attr("stroke", "#d1d5db")
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "4 4");
    }

    // Draw nodes
    const nodeG = svg
      .selectAll("g.node")
      .data(sorted)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = H_GAP + col * (NODE_W + H_GAP);
        const y = V_GAP + row * (NODE_H + V_GAP);
        return `translate(${x},${y})`;
      });

    // Card background
    nodeG
      .append("rect")
      .attr("width", NODE_W)
      .attr("height", NODE_H)
      .attr("rx", 10)
      .attr("fill", (d) => {
        if (d.maturityRate >= 1) return "#dcfce7";
        if (d.maturityRate > 0) return "#fef9c3";
        return "#f9fafb";
      })
      .attr("stroke", (d) => {
        if (d.maturityRate >= 1) return "#16a34a";
        if (d.maturityRate > 0) return "#ca8a04";
        return "#d1d5db";
      })
      .attr("stroke-width", 1.5);

    // Progress bar background
    nodeG
      .append("rect")
      .attr("x", 8)
      .attr("y", NODE_H - 14)
      .attr("width", NODE_W - 16)
      .attr("height", 6)
      .attr("rx", 3)
      .attr("fill", "#e5e7eb");

    // Progress bar fill
    nodeG
      .append("rect")
      .attr("x", 8)
      .attr("y", NODE_H - 14)
      .attr("width", 0)
      .attr("height", 6)
      .attr("rx", 3)
      .attr("fill", (d) => (d.maturityRate >= 1 ? "#16a34a" : "#facc15"))
      .transition()
      .duration(800)
      .delay((_, i) => i * 80)
      .attr("width", (d) => (NODE_W - 16) * d.maturityRate);

    // Circle badge (maturity %)
    nodeG
      .append("circle")
      .attr("cx", NODE_W - RADIUS - 6)
      .attr("cy", RADIUS + 4)
      .attr("r", RADIUS)
      .attr("fill", "white")
      .attr("stroke", (d) => (d.maturityRate >= 1 ? "#16a34a" : "#d1d5db"))
      .attr("stroke-width", 1.5);

    nodeG
      .append("text")
      .attr("x", NODE_W - RADIUS - 6)
      .attr("y", RADIUS + 4)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", 9)
      .attr("fill", "#374151")
      .text((d) => `${Math.round(d.maturityRate * 100)}%`);

    // Node title
    nodeG
      .append("foreignObject")
      .attr("x", 8)
      .attr("y", 6)
      .attr("width", NODE_W - RADIUS * 2 - 18)
      .attr("height", NODE_H - 26)
      .append("xhtml:div")
      .style("font-size", "11px")
      .style("font-weight", "600")
      .style("color", "#111827")
      .style("line-height", "1.3")
      .style("overflow", "hidden")
      .style("display", "-webkit-box")
      .style("-webkit-line-clamp", "2")
      .style("-webkit-box-orient", "vertical")
      .text((d) => d.title);

    // Card count label
    nodeG
      .append("text")
      .attr("x", 8)
      .attr("y", NODE_H - 18)
      .attr("font-size", 9)
      .attr("fill", "#6b7280")
      .text((d) => (d.totalCards > 0 ? `${d.matureCards}/${d.totalCards} cards` : "no cards"));

    // Overall progress bar at bottom
    const barY = height - 36;
    const barW = width - 40;
    svg
      .append("text")
      .attr("x", 20)
      .attr("y", barY - 8)
      .attr("font-size", 12)
      .attr("font-weight", "600")
      .attr("fill", "#374151")
      .text(`Overall Progress: ${Math.round(overallMaturityRate * 100)}%`);

    svg
      .append("rect")
      .attr("x", 20)
      .attr("y", barY)
      .attr("width", barW)
      .attr("height", 10)
      .attr("rx", 5)
      .attr("fill", "#e5e7eb");

    svg
      .append("rect")
      .attr("x", 20)
      .attr("y", barY)
      .attr("width", 0)
      .attr("height", 10)
      .attr("rx", 5)
      .attr("fill", overallMaturityRate >= 1 ? "#16a34a" : "#3b82f6")
      .transition()
      .duration(1000)
      .attr("width", barW * overallMaturityRate);
  }, [nodes, overallMaturityRate]);

  return (
    <div className="overflow-x-auto">
      <svg ref={svgRef} className="block" />
    </div>
  );
}
