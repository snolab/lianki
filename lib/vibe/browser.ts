"use client";

// The browser's half of a /vibe session (lib/vibe/session.ts): the routes, and
// the same mic and Mac client the chat uses, loaded only when Start is tapped.
// No `device` or `filter` goes to the Mac: every speaker is kept (the owner's
// choice), so the voiceprint filter stays off on this socket.
import type { MicTaps } from "@lianki/debug-chat/mic-taps";
import type { ApiResult, VibeApi, VibeDeps } from "./session";
import { vibeRoute } from "./session";

async function postJson<T>(url: string, body: unknown, keepalive: boolean): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, ...((await res.json()) as T) };
}

export const vibeApi: VibeApi = {
  start: (b) => postJson("/api/vibe", b, false),
  lines: (id, b, keepalive) => postJson(`/api/vibe/${encodeURIComponent(id)}/lines`, b, keepalive),
  state: (id, state, keepalive) =>
    postJson(`/api/vibe/${encodeURIComponent(id)}/state`, { state }, keepalive),
};

function watchPage(f: (why: "hidden" | "offline") => void): () => void {
  const vis = () => {
    if (document.visibilityState === "hidden") f("hidden");
  };
  const gone = () => f("hidden");
  const off = () => f("offline");
  document.addEventListener("visibilitychange", vis);
  window.addEventListener("pagehide", gone);
  window.addEventListener("offline", off);
  return () => {
    document.removeEventListener("visibilitychange", vis);
    window.removeEventListener("pagehide", gone);
    window.removeEventListener("offline", off);
  };
}

export async function vibeBrowserDeps(): Promise<Omit<VibeDeps, "onView">> {
  const [{ voiceCapture }, { createLocalStt, LOCAL_STT_KEY }, { getKey }, { micTaps }] =
    await Promise.all([
      import("@lianki/debug-chat/MicButton"),
      import("@lianki/debug-chat/local-stt"),
      import("@lianki/debug-chat/storage-keys"),
      import("@lianki/debug-chat/mic-taps"),
    ]);
  const capture = voiceCapture();
  const taps: MicTaps = micTaps();
  return {
    api: vibeApi,
    stt: () => {
      let stored: string | null = null;
      try {
        stored = getKey(LOCAL_STT_KEY);
      } catch {}
      const urls = vibeRoute(stored);
      return urls ? createLocalStt(urls, {}) : null;
    },
    getStream: capture.getStream,
    load: (ev, s) => capture.load(ev, s as MediaStream),
    fallback: (ev, s) => capture.fallback(ev, s as MediaStream),
    holdChatMic: () => taps.block(),
    // createMic and the session log counts and reasons, never text.
    log: (ev) => console.info("vibe", JSON.stringify(ev)),
    watchPage,
    isHidden: () => document.visibilityState === "hidden",
  };
}
