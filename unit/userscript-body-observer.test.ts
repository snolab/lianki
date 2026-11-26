import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { USERSCRIPT_STRINGS } from "../src/userscript-strings";

// Exercise the actual shipped pill initializer, including both its observer
// target and its mount. Fixing only observe(null) leaves appendChild(null) next.
const built = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf8");
const start = built.indexOf("function createUI(");
if (start < 0) throw Error("Built pill initializer missing");
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
if (end < 0) throw Error("Built pill initializer is unterminated");

function mount(bodyPresent: boolean) {
  const win = new Window({ url: "https://example.test/" });
  if (!bodyPresent) win.document.body.remove();
  const controller = new win.AbortController();
  const targets: unknown[] = [];
  const observers: InstanceType<typeof win.MutationObserver>[] = [];
  // Match the browser's Node-brand check (the real reported exception) while
  // retaining actual DOM mutation delivery rather than a no-op observer mock.
  function StrictObserver(callback: Function) {
    const observer = new win.MutationObserver(callback as never);
    observers.push(observer);
    return {
      observe(target: unknown, options: MutationObserverInit) {
        if (!(target instanceof win.Node)) throw TypeError("target must be a Node");
        targets.push(target);
        observer.observe(target as never, options);
      },
      disconnect: () => observer.disconnect(),
    };
  }
  const run = new Function(
    "document",
    "window",
    "MutationObserver",
    "signal",
    "US",
    "liChat",
    "addInterval",
    "GM_getValue",
    "GM_registerMenuCommand",
    `let videoObserver; ${built.slice(start, end)}; return createUI();`,
  );
  try {
    const container = run(
      win.document,
      win,
      StrictObserver,
      controller.signal,
      USERSCRIPT_STRINGS.en,
      { strings: { liTitle: "Li" }, entry: () => "hidden", flagOn: () => false },
      () => 0,
      (_key: string, fallback: unknown) => fallback,
      undefined,
    ) as InstanceType<typeof win.HTMLElement>;
    return {
      win,
      container,
      targets,
      close() {
        controller.abort();
        for (const observer of observers) observer.disconnect();
        void win.happyDOM.close();
      },
    };
  } catch (error) {
    controller.abort();
    for (const observer of observers) observer.disconnect();
    void win.happyDOM.close();
    throw error;
  }
}

test("initializes before body exists, then reacts to media in the arriving body", async () => {
  const r = mount(false);
  try {
    expect(r.targets).toEqual([r.win.document.documentElement]);
    expect(r.container.parentNode).toBe(r.win.document.documentElement);
    expect(r.container.querySelector("button")!.style.display).toBe("none");
    const body = r.win.document.createElement("body");
    r.win.document.documentElement.append(body);
    body.append(r.win.document.createElement("video"));
    await Bun.sleep(10);
    expect(r.container.querySelector("button")!.style.display).toBe("");
  } finally {
    r.close();
  }
});

test("keeps the existing body mount and media updates when body is already present", async () => {
  const r = mount(true);
  try {
    expect(r.targets).toEqual([r.win.document.body]);
    expect(r.container.parentNode).toBe(r.win.document.body);
    const media = r.win.document.createElement("audio");
    r.win.document.body.append(media);
    await Bun.sleep(10);
    expect(r.container.querySelector("button")!.style.display).toBe("");
    media.remove();
    await Bun.sleep(10);
    expect(r.container.querySelector("button")!.style.display).toBe("none");
  } finally {
    r.close();
  }
});
