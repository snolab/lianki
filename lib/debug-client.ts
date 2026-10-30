import { getKey, migrateKeys, queryFlag, setKey } from "@lianki/debug-chat/storage-keys";

/**
 * Remote-debug mode, in the browser — users know it as their learning partner
 * (docs/dev-debug-widget.md, "Naming"). `?debug=1` or `?agent=1` on any page
 * turns it on for this device (`=0` off); the installed app toggles it with seven quick
 * taps on /words' Settings button or ten on your own name in the profile menu
 * (top right, any page). For the owner it opens remote eval, the agent chat
 * and /api/dev/log. For any other signed-in user it opens only their own chat
 * thread with the agent (and a "Preview" prompt when the agent asks to run
 * code on their device); a guest gets nothing.
 */
const KEY = "lk:debug";
/** Fired on window when this tab turns debug mode on or off. */
export const DEBUG_EVENT = "lk:debug";

let migrated = false;

export function debugOn(): boolean {
  try {
    // Once per page load: copy lk:debug* to lk:agent* (storage-keys.ts).
    if (!migrated) migrated = (migrateKeys(), true);
    const q = queryFlag(location.search);
    if (q !== null) setKey(KEY, q === "1" ? "1" : "0");
    return getKey(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebug(on: boolean) {
  setKey(KEY, on ? "1" : "0");
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
