/**
 * Remote-debug mode, in the browser. `?debug=1` on any page turns it on for
 * this device (`?debug=0` off); the installed app toggles it with seven quick
 * taps on /words' Settings button. For the owner it opens remote eval, the
 * agent chat and /api/dev/log. For any other signed-in user it opens only
 * their own chat thread with the agent (and a "Preview" prompt when the agent
 * asks to run code on their device); a guest gets nothing.
 */
const KEY = "lk:debug";
/** Fired on window when this tab turns debug mode on or off. */
export const DEBUG_EVENT = "lk:debug";

export function debugOn(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("debug");
    if (q !== null) localStorage.setItem(KEY, q === "1" ? "1" : "0");
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebug(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(DEBUG_EVENT));
}

/** Post an event to the Worker logs (`wrangler tail lianki`), in debug mode only. */
export function devLog(event: Record<string, unknown>) {
  try {
    if (!debugOn()) return;
    void fetch("/api/dev/log", {
      method: "POST",
      body: JSON.stringify({ at: new Date().toISOString(), ...event }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
