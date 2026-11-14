/**
 * useDeviceZone / useZonedTime (app/components): the server knows no zone, so
 * a server render formats in UTC and says so; the client reads the device
 * zone and formats and keys days in it (owner, 2026-11-15: never a fixed
 * zone, UTC only as the fallback).
 */
import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { stubGlobals } from "./support/globals";
import { useDeviceZone } from "../app/components/useDeviceZone";
import { useZonedTime } from "../app/components/useZonedTime";
import { deviceZone } from "@/lib/time-zone";

const AT = Date.UTC(2026, 10, 14, 19, 30); // 2026-11-14 19:30Z = 2026-11-15 04:30 in UTC+9

function Probe() {
  const z = useDeviceZone();
  const { zone, time, day } = useZonedTime();
  return (
    <p data-zone={z ?? "null"} data-used={zone} data-day={day(AT)}>
      {time(AT, "en", { hour: "2-digit", minute: "2-digit", hour12: false })}
    </p>
  );
}

it("server render: no device zone yet, so UTC, labelled", () => {
  const html = renderToStaticMarkup(<Probe />);
  expect(html).toContain('data-zone="null"');
  expect(html).toContain('data-used="UTC"');
  expect(html).toContain('data-day="2026-11-14"');
  expect(html).toContain("19:30");
});

it("client render: the device zone, its day and its label", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await act(() => root.render(<Probe />));
    const p = host.querySelector("p")!;
    const zone = deviceZone();
    expect(p.getAttribute("data-zone")).toBe(zone);
    expect(p.getAttribute("data-used")).toBe(zone);
    // The day and the clock follow the zone the hook reported, whatever the machine's is.
    const off = -new Date(AT).getTimezoneOffset();
    const shifted = new Date(AT + off * 60_000);
    expect(p.getAttribute("data-day")).toBe(shifted.toISOString().slice(0, 10));
    expect(p.textContent).toMatch(/\d{2}:\d{2}/);
    await act(() => root.unmount());
  } finally {
    restore();
  }
});
