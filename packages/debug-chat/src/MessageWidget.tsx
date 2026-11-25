/**
 * A message widget (message-widget.ts) as the page's own components: buttons,
 * a calculator, a slider, a table. No script from the line runs; a widget only
 * puts text into his reply box (host.onReply), and he sends it himself.
 * Colours in oklch(), through light-dark() for both themes.
 */
import { type ReactNode, type SyntheticEvent, useId, useMemo, useState } from "react";
import { calc, calcShown, parseWidget, sliderReply } from "./message-widget";

export type WidgetLabels = {
  /** The button that puts a calculator's or slider's value into his reply. */
  use: string;
  /** Under a calculator whose input is not arithmetic. */
  invalid: string;
  /** Tooltip on every widget control: it fills the reply box, it does not send. */
  hint: string;
  /** Above an HTML widget whose script was stripped (script widgets are off). */
  scriptsOff: string;
};
export type WidgetHost = {
  /** Puts text into his reply box; he sends it. */
  onReply: (text: string) => void;
  /** An HTML widget's form submit: sent as his line (into the box instead when he is typing). */
  onSubmit: (text: string) => void;
  labels: WidgetLabels;
  /** Config chat.widgetHtmlMaxPx: the tallest a sandboxed HTML widget grows. */
  htmlMaxHeight?: number;
};

const INK = "light-dark(oklch(0.46 0.187 22.3), oklch(0.8 0.132 22.3))";
const RULE = "light-dark(oklch(0.5 0.01 260 / 0.35), oklch(0.85 0.01 260 / 0.35))";
const FIELD_BG = "light-dark(oklch(1 0 0 / 0.7), oklch(0.25 0.01 260 / 0.7))";

/** A widget's controls take the pointer and keep their taps from the message around them. */
const own = {
  onClick: (e: SyntheticEvent) => e.stopPropagation(),
  onPointerDown: (e: SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: SyntheticEvent) => e.stopPropagation(),
};

function Box({ type, title, children }: { type: string; title?: string; children: ReactNode }) {
  return (
    <div
      data-testid="debug-chat-widget"
      data-widget-type={type}
      className="pointer-events-auto my-1 flex max-w-full flex-col gap-1.5 rounded-lg border p-2"
      style={{ borderColor: RULE }}
      {...own}
    >
      {title && <div className="font-semibold">{title}</div>}
      {children}
    </div>
  );
}

function UseButton({ host, text }: { host: WidgetHost; text: string | null }) {
  return (
    <button
      type="button"
      data-testid="debug-chat-widget-use"
      disabled={text === null}
      title={host.labels.hint}
      className="shrink-0 rounded-full border px-3 py-0.5 font-semibold disabled:opacity-40"
      style={{ borderColor: INK, color: INK }}
      onClick={() => text !== null && host.onReply(text)}
    >
      {host.labels.use}
    </button>
  );
}

function Calc({ host, expr, title }: { host: WidgetHost; expr: string; title?: string }) {
  const [v, setV] = useState(expr);
  const id = useId();
  const r = calc(v);
  const shown = r === null ? null : calcShown(r);
  return (
    <Box type="calc" title={title}>
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          id={id}
          data-testid="debug-chat-widget-calc"
          inputMode="decimal"
          aria-label={title}
          value={v}
          onChange={(e) => setV(e.target.value)}
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono"
          style={{ borderColor: RULE, background: FIELD_BG }}
        />
        <output htmlFor={id} data-testid="debug-chat-widget-result" className="font-mono">
          {shown === null ? host.labels.invalid : `= ${shown}`}
        </output>
        <UseButton host={host} text={shown === null ? null : `${v.trim()} = ${shown}`} />
      </div>
    </Box>
  );
}

export function MessageWidget({ spec, host }: { spec: string; host: WidgetHost }) {
  const w = useMemo(() => parseWidget(spec), [spec]);
  const [slider, setSlider] = useState<number | null>(null);
  if (!w) return null;
  if (w.type === "calc") return <Calc host={host} expr={w.expr} title={w.title} />;
  if (w.type === "buttons")
    return (
      <Box type="buttons" title={w.title}>
        {/* All the choices side by side, one segmented row (wraps on a narrow phone). */}
        <div
          role="group"
          aria-label={w.title}
          className="inline-flex max-w-full flex-wrap self-start overflow-hidden rounded-2xl border"
          style={{ borderColor: INK }}
        >
          {w.options.map((o, i) => (
            <button
              key={i}
              type="button"
              data-testid="debug-chat-widget-option"
              title={host.labels.hint}
              className="px-3 py-1 font-semibold"
              style={{ color: INK, ...(i > 0 ? { borderInlineStart: `1px solid ${INK}` } : {}) }}
              onClick={() => host.onReply(o)}
            >
              {o}
            </button>
          ))}
        </div>
      </Box>
    );
  if (w.type === "slider") {
    const value = slider ?? w.value;
    return (
      <Box type="slider" title={w.title}>
        <label className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{w.label}</span>
          <input
            type="range"
            data-testid="debug-chat-widget-slider"
            min={w.min}
            max={w.max}
            step={w.step}
            value={value}
            onChange={(e) => setSlider(Number(e.target.value))}
            className="min-w-0 flex-1"
            style={{ accentColor: INK }}
          />
          <output className="shrink-0 font-mono">
            {value}
            {w.unit ? ` ${w.unit}` : ""}
          </output>
        </label>
        <div className="flex justify-end">
          <UseButton host={host} text={sliderReply(w, value)} />
        </div>
      </Box>
    );
  }
  return (
    <Box type="table" title={w.title}>
      <div className="max-w-full overflow-x-auto">
        <table className="w-max border-collapse fs-11 leading-snug">
          <thead>
            <tr>
              {w.columns.map((c, i) => (
                <th
                  key={i}
                  className="border px-1.5 py-0.5 text-start font-semibold"
                  style={{ borderColor: RULE }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {w.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className="border px-1.5 py-0.5 align-top" style={{ borderColor: RULE }}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Box>
  );
}
