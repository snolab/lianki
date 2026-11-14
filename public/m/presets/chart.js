/*
 * Lianki chart preset for mini apps (docs/mini-apps.md, "Presets").
 * <script src="/m/presets/chart.js"></script>
 * lkChart.bar(el, [{label, value}], {title})   lkChart.line(el, [numbers or {label, value}], {title})
 * Plain SVG styled only with the style pack's variables (--lk-chart-1…4,
 * --lk-fg, --lk-muted, --lk-line), so it follows light and dark by itself.
 * Phase 2 swaps in rgui's components (docs/rgui.md) built as a preset.
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  function el(name, attrs, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function norm(data) {
    return (data || []).map(function (d, i) {
      return typeof d === "number" ? { label: String(i + 1), value: d } : d;
    });
  }
  function frame(target, opts) {
    var W = 320,
      H = 180,
      P = 24;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", width: "100%" });
    if (opts && opts.title) svg.appendChild(el("title", {}, opts.title));
    svg.appendChild(
      el("line", { x1: P, y1: H - P, x2: W - 8, y2: H - P, stroke: "var(--lk-line)" }),
    );
    var host = typeof target === "string" ? document.querySelector(target) : target;
    host.replaceChildren(svg);
    return { svg: svg, W: W, H: H, P: P };
  }
  function bar(target, data, opts) {
    var d = norm(data),
      f = frame(target, opts);
    var max = Math.max.apply(null, d.map((x) => x.value).concat([1]));
    var w = (f.W - f.P - 8) / Math.max(d.length, 1);
    d.forEach(function (x, i) {
      var h = ((f.H - 2 * f.P) * x.value) / max;
      f.svg.appendChild(
        el("rect", {
          x: f.P + i * w + w * 0.15,
          y: f.H - f.P - h,
          width: w * 0.7,
          height: Math.max(h, 0),
          rx: 3,
          fill: "var(--lk-chart-" + ((i % 4) + 1) + ")",
        }),
      );
      f.svg.appendChild(
        el(
          "text",
          {
            x: f.P + i * w + w / 2,
            y: f.H - 8,
            "text-anchor": "middle",
            "font-size": 10,
            fill: "var(--lk-muted)",
          },
          x.label,
        ),
      );
    });
    return f.svg;
  }
  function line(target, data, opts) {
    var d = norm(data),
      f = frame(target, opts);
    var max = Math.max.apply(null, d.map((x) => x.value).concat([1]));
    var step = (f.W - f.P - 8) / Math.max(d.length - 1, 1);
    var pts = d.map(function (x, i) {
      return [f.P + i * step, f.H - f.P - ((f.H - 2 * f.P) * x.value) / max];
    });
    f.svg.appendChild(
      el("polyline", {
        points: pts.map((p) => p.join(",")).join(" "),
        fill: "none",
        stroke: "var(--lk-chart-1)",
        "stroke-width": 2.5,
        "stroke-linejoin": "round",
      }),
    );
    pts.forEach(function (p) {
      f.svg.appendChild(el("circle", { cx: p[0], cy: p[1], r: 3, fill: "var(--lk-chart-1)" }));
    });
    return f.svg;
  }
  window.lkChart = Object.freeze({ bar: bar, line: line });
})();
