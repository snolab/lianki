import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, act, useState } from "react";
import { stubGlobals } from "./support/globals";
import { NativeAudioClient } from "../lib/words/native-audio-client";
import { useNativeAudio } from "../lib/words/use-native-audio";

test("default client survives readiness notifications and changing render callbacks", async () => {
  const win = new Window();
  let requests = 0,
    notifications = 0;
  const playing = { current: new AbortController() };
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => {
      requests++;
      return Response.json({ user: "account-a", prefs: {} });
    },
  });
  const clients: NativeAudioClient[] = [];
  function Probe() {
    const [, changed] = useState(0);
    const client = useNativeAudio(playing, undefined, () => {
      notifications++;
      // Bound the regression: the broken hook would recreate on every
      // readiness notification and keep requesting the account forever.
      if (notifications < 5) changed((n) => n + 1);
    });
    if (client.current) clients.push(client.current);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.createElement("div") as never);
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe)));
    expect(requests).toBe(1);
    expect(notifications).toBe(1);
    expect(new Set(clients).size).toBe(1);
    expect(playing.current.signal.aborted).toBe(false);
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});

test("Strict Mode setup-cleanup-setup owns a fresh client and pagehide cancels before clearing", async () => {
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const clients: NativeAudioClient[] = [],
    disposed: number[] = [],
    playing = { current: new AbortController() };
  let current: ReturnType<typeof useNativeAudio> | undefined,
    requests = 0;
  const make = () => {
    const i = clients.length;
    const client = new NativeAudioClient({
      timeoutMs: () => 15000,
      fetch: async () => {
        requests++;
        return Response.json({ user: "account-a", prefs: {} });
      },
      createObjectURL: () => {
        throw Error("no audio expected");
      },
      revokeObjectURL: () => {},
    });
    const dispose = client.dispose.bind(client);
    client.dispose = () => {
      disposed.push(i);
      dispose();
    };
    const clear = client.clear.bind(client);
    client.clear = () => {
      expect(playing.current.signal.aborted).toBe(true);
      clear();
    };
    clients.push(client);
    return client;
  };
  function Probe() {
    current = useNativeAudio(playing, make);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.createElement("div") as never);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))));
    expect(clients).toHaveLength(2);
    expect(disposed).toEqual([0]);
    expect(current!.current).toBe(clients[1]);
    expect(clients[1].ready).toBe(true);
    await act(() => win.dispatchEvent(new win.Event("pagehide")));
    expect(clients[1].ready).toBe(false);
    await act(() => win.dispatchEvent(new win.Event("pageshow")));
    expect(clients[1].ready).toBe(true);
    const before = requests;
    await act(async () => root.unmount());
    expect(disposed).toEqual([0, 1]);
    expect(current!.current).toBeNull();
    expect(
      await clients[1].load({ listId: "list", term: "word" }, new AbortController().signal),
    ).toBeNull();
    expect(requests).toBe(before);
  } finally {
    restore();
    await win.happyDOM.close();
  }
});

test("default client uses authenticated requests and refreshes after cross-tab changes", async () => {
  const win = new Window();
  let requests = 0,
    current: ReturnType<typeof useNativeAudio> | undefined;
  const playing = { current: new AbortController() };
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, init: RequestInit) => {
      expect(init.credentials).toBe("same-origin");
      requests++;
      return Response.json({ user: "account-a", prefs: {} });
    },
  });
  function Probe() {
    current = useNativeAudio(playing);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.createElement("div") as never);
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(current!.current?.ready).toBe(true);
    const before = requests;
    await act(() => win.dispatchEvent(new win.StorageEvent("storage", { key: "lk:pref-sync" })));
    expect(playing.current.signal.aborted).toBe(true);
    expect(requests).toBeGreaterThan(before);
    expect(current!.current?.ready).toBe(true);
    await act(() => win.dispatchEvent(new win.Event("online")));
    await act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));
    expect(current!.current?.enabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});
