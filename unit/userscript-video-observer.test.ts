import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// Lift the actual built media tracker. The pill has a separate observer and
// its successful mount alone does not prove this later startup step succeeded.
const built = readFileSync("public/lianki.user.js", "utf8");
const start = built.indexOf("function observeVideos(");
if (start < 0) throw new Error("Built media tracker missing");
const open = built.indexOf("{", start);
let depth = 0;
let end = -1;
for (let i = open; i < built.length; i++) {
  if (built[i] === "{") depth++;
  else if (built[i] === "}" && --depth === 0) {
    end = i + 1;
    break;
  }
}
if (end < 0) throw new Error("Built media tracker unterminated");

function track(bodyPresent: boolean, aborted = false) {
  const win = new Window({ url: "https://example.test" });
  if (!bodyPresent) win.document.body.remove();
  else win.document.body.append(win.document.createElement("audio"));
  const controller = new win.AbortController();
  if (aborted) controller.abort();
  const targets: unknown[] = [];
  const speed: unknown[] = [];
  const watch: unknown[] = [];
  const heat: unknown[] = [];
  const observers: InstanceType<typeof win.MutationObserver>[] = [];
  let disconnected = 0;
  function StrictObserver(callback: Function) {
    const observer = new win.MutationObserver(callback as never);
    observers.push(observer);
    return {
      observe(target: unknown, options: MutationObserverInit) {
        if (!(target instanceof win.Node)) throw new TypeError("target must be a Node");
        targets.push(target);
        observer.observe(target as never, options);
      },
      disconnect() {
        disconnected++;
        observer.disconnect();
      },
    };
  }
  const run = new Function(
    "document",
    "MutationObserver",
    "signal",
    "$$",
    "setupVideoSpeedTracking",
    "setupWatchTracking",
    "setupHeatmap",
    `${built.slice(start, end)}; observeVideos();`,
  );
  const close = () => {
    controller.abort();
    for (const observer of observers) observer.disconnect();
    void win.happyDOM.close();
  };
  try {
    run(
      win.document,
      StrictObserver,
      controller.signal,
      (selector: string) => [...win.document.querySelectorAll(selector)],
      (v: unknown) => speed.push(v),
      (v: unknown) => watch.push(v),
      (v: unknown) => heat.push(v),
    );
    return {
      win,
      controller,
      targets,
      speed,
      watch,
      heat,
      disconnected: () => disconnected,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

test("media tracking can start before body and sees the arriving body's media once", async () => {
  const r = track(false);
  try {
    expect(r.targets[0] === r.win.document.documentElement).toBe(true);
    const body = r.win.document.createElement("body");
    r.win.document.documentElement.append(body);
    const video = r.win.document.createElement("video");
    body.append(video);
    await Bun.sleep(10);
    expect(r.speed.length).toBe(1);
    expect(r.speed[0] === video).toBe(true);
    expect(r.watch[0] === video).toBe(true);
    expect(r.heat[0] === video).toBe(true);
    body.append(r.win.document.createElement("div"));
    await Bun.sleep(10);
    expect(r.speed.length).toBe(1);
  } finally {
    r.close();
  }
});

test("existing body media is tracked, and unload disconnects before later mutations", async () => {
  const r = track(true);
  try {
    expect(r.targets[0] === r.win.document.body).toBe(true);
    expect(r.speed.length).toBe(1);
    r.win.document.body.append(r.win.document.createElement("div"));
    await Bun.sleep(10);
    expect(r.speed.length).toBe(1);
    r.controller.abort();
    expect(r.disconnected()).toBe(1);
    r.win.document.body.append(r.win.document.createElement("video"));
    await Bun.sleep(10);
    expect(r.speed.length).toBe(1);
    expect(r.watch.length).toBe(1);
    expect(r.heat.length).toBe(1);
  } finally {
    r.close();
  }
});

test("a retired startup cannot attach a fresh observer after unload", () => {
  const r = track(true, true);
  try {
    expect(r.targets.length).toBe(0);
    expect(r.speed.length).toBe(0);
    expect(r.watch.length).toBe(0);
    expect(r.heat.length).toBe(0);
  } finally {
    r.close();
  }
});
