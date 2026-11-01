/**
 * qa-partner-embed.ts fixture: the userscript's real frame shell
 * (src/partner-frame.ts) on a test page, as `window.__lkShell(appOrigin)`,
 * resolving to the handshake's result. The ticket is a fixed test value.
 */
import { frameShell } from "../../src/partner-frame";

(window as unknown as { __lkShell: (o: string) => Promise<string> }).__lkShell = (origin) =>
  frameShell({
    doc: document,
    win: window,
    origin,
    label: `${location.host}${location.pathname}`,
    ticket: async () => "TK-frame",
    gripLabel: "Drag to move; double-click to minimize",
  }).result;
