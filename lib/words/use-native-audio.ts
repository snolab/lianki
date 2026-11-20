"use client";
import { useEffect, useRef, type RefObject } from "react";
import { outputBed } from "@lianki/debug-chat/output-bed";
import { publicCfg } from "@/lib/config-client";
import { NativeAudioClient } from "./native-audio-client";

const create = () =>
  new NativeAudioClient({
    fetch: fetch.bind(globalThis),
    timeoutMs: () => publicCfg("words.nativeAudioTimeoutMs"),
    createObjectURL: URL.createObjectURL.bind(URL),
    revokeObjectURL: URL.revokeObjectURL.bind(URL),
  });

/** Each effect setup owns a fresh lease; Strict Mode never reuses a disposed client. */
export function useNativeAudio(
  playing: RefObject<AbortController | null>,
  make: () => NativeAudioClient = create,
) {
  const current = useRef<NativeAudioClient | null>(null);
  useEffect(() => {
    const client = make();
    current.current = client;
    void client.prepare();
    const clear = () => {
      playing.current?.abort();
      client.clear();
    };
    const refresh = () => {
      if (document.visibilityState !== "hidden") void client.prepare();
    };
    const changed = (event: StorageEvent) => {
      if (event.key === "lk:pref-sync") {
        clear();
        refresh();
      }
    };
    const off = outputBed().onExit(clear);
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      off();
      playing.current?.abort();
      client.dispose();
      if (current.current === client) current.current = null;
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [make, playing]);
  return current;
}
