import { confirmBrowserModelDownload } from "../packages/debug-chat/src/model-download-consent";
import { stubGlobals } from "./support/globals";
import { describe, expect, test } from "bun:test";
import {
  downloadModelAssets,
  browserModelNetwork,
  modelDownloadRisk,
  ModelDownloadBlocked,
  type ModelConnection,
  type ModelNetwork,
} from "../packages/debug-chat/src/model-download";
import {
  createKws,
  KWS_ASSETS,
  workerSource,
  type WorkerLike,
} from "../packages/debug-chat/src/wake-kws";
import { CHAT_LOCALES, EXTRA, EXTRA_CONTEXT } from "../packages/debug-chat/src/chat-ui-locales";

const asset = { url: "https://models.example/model" };
function setup(initial: ModelNetwork = { connection: { type: "wifi" } }) {
  const connection = new EventTarget() as EventTarget & ModelConnection;
  Object.assign(connection, initial.connection);
  let n: ModelNetwork = { ...initial, connection };
  const events = new EventTarget();
  const stored = new Map<string, Response>();
  const calls: RequestInit[] = [];
  const h = {
    stored,
    calls,
    connection,
    events,
    change(next: ModelNetwork) {
      n = {
        ...next,
        connection: Object.assign(
          connection,
          { type: undefined, saveData: false, metered: false, effectiveType: undefined },
          next.connection,
        ),
      };
      connection.dispatchEvent(new Event("change"));
    },
    run(options: Partial<Parameters<typeof downloadModelAssets>[0]> = {}) {
      return downloadModelAssets({
        assets: [asset],
        estimatedMb: 25,
        cacheName: "fixture",
        network: () => n,
        events: events as unknown as Window,
        cache: async () =>
          ({
            match: async (u) => stored.get(String(u))?.clone(),
            put: async (u, r) => {
              stored.set(String(u), r.clone());
            },
            delete: async (u) => stored.delete(String(u)),
          }) as Pick<Cache, "match" | "put" | "delete">,
        fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
          calls.push(init!);
          return new Response("model");
        }) as unknown as typeof fetch,
        ...options,
      });
    },
  };
  return h;
}

describe("model download billing/network boundary", () => {
  test("speed alone is unknown; Wi-Fi/ethernet are eligible unless explicitly restricted", () => {
    expect(modelDownloadRisk({})).toBe("unknown");
    expect(modelDownloadRisk({ connection: { effectiveType: "4g" } })).toBe("unknown");
    for (const type of ["wifi", "ethernet"])
      expect(modelDownloadRisk({ connection: { type } })).toBe("unmetered");
    for (const n of [
      { online: false },
      { connection: { type: "cellular" } },
      { connection: { type: "none" } },
      { connection: { type: "wifi", saveData: true } },
      { connection: { type: "ethernet", metered: true } },
    ])
      expect(modelDownloadRisk(n)).toBe("restricted");
  });
  test("cached files work on cellular without prompting or network", async () => {
    const h = setup({ connection: { type: "cellular" } });
    h.stored.set(asset.url, new Response("cached"));
    const out = await h.run({
      confirm: () => {
        throw Error("must not prompt");
      },
    });
    expect(new TextDecoder().decode(out[0].bytes)).toBe("cached");
    expect(h.calls).toHaveLength(0);
  });
  test("restricted and unknown networks fetch nothing on refusal or missing UI", async () => {
    for (const network of [
      {},
      { connection: { type: "cellular" } },
      { connection: { type: "wifi", saveData: true } },
      { connection: { metered: true } },
    ]) {
      const h = setup(network);
      await expect(h.run()).rejects.toBeInstanceOf(ModelDownloadBlocked);
      await expect(h.run({ confirm: () => false })).rejects.toBeInstanceOf(ModelDownloadBlocked);
      expect(h.calls).toHaveLength(0);
    }
  });
  test("explicit approval includes size and permits just this download", async () => {
    const h = setup({ connection: { type: "cellular" } });
    let shown: unknown;
    const out = await h.run({
      confirm: (info) => {
        shown = info;
        return true;
      },
    });
    expect(shown).toMatchObject({ estimatedMb: 25, risk: "restricted" });
    expect((shown as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(out).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.stored.has(asset.url)).toBe(true);
    h.stored.clear();
    await expect(h.run()).rejects.toBeInstanceOf(ModelDownloadBlocked);
  });
  test("Wi-Fi downloads need no prompt; cache failure still enforces unknown-network consent", async () => {
    const h = setup();
    await h.run({
      confirm: () => {
        throw Error("unexpected");
      },
    });
    expect(h.calls).toHaveLength(1);
    const u = setup({});
    await expect(
      u.run({
        cache: async () => {
          throw Error("private mode");
        },
      }),
    ).rejects.toBeInstanceOf(ModelDownloadBlocked);
    expect(u.calls).toHaveLength(0);
  });
  test("network changes during confirmation cannot authorize the new connection", async () => {
    const h = setup({ connection: { type: "cellular" } });
    await expect(
      h.run({
        confirm: () => {
          h.change({ connection: { type: "cellular", saveData: true } });
          return true;
        },
      }),
    ).rejects.toBeInstanceOf(ModelDownloadBlocked);
    expect(h.calls).toHaveLength(0);
  });
  test("a switch to cellular aborts the actual in-flight fetch and no later file starts", async () => {
    const h = setup();
    let signal: AbortSignal | undefined;
    const task = h.run({
      assets: [asset, { url: asset.url + "-2" }],
      fetch: ((_u: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal!;
          signal!.addEventListener("abort", () => reject(signal!.reason));
        })) as unknown as typeof fetch,
    });
    while (!signal) await Bun.sleep(1);
    h.change({ connection: { type: "cellular" } });
    await expect(task).rejects.toBeInstanceOf(ModelDownloadBlocked);
    expect(signal!.aborted).toBe(true);
  });
  test("stopping a download aborts; going offline aborts but harmless Wi-Fi changes do not", async () => {
    const h = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(h.run({ signal: ac.signal })).rejects.toBeInstanceOf(ModelDownloadBlocked);
    expect(h.calls).toHaveLength(0);
    await expect(
      h.run({
        fetch: (async () => {
          h.events.dispatchEvent(new Event("offline"));
          return new Response("x");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ModelDownloadBlocked);
    const w = setup();
    await w.run({
      fetch: (async () => {
        w.change({ connection: { type: "wifi", effectiveType: "4g" } });
        return new Response("x");
      }) as unknown as typeof fetch,
    });
  });
  test("corrupt cached files require consent before refetch and fetched bytes must match", async () => {
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("valid"))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const h = setup({ connection: { type: "cellular" } });
    h.stored.set(asset.url, new Response("bad"));
    await expect(h.run({ assets: [{ ...asset, sha256: digest }] })).rejects.toBeInstanceOf(
      ModelDownloadBlocked,
    );
    expect(h.calls).toHaveLength(0);
    expect(h.stored.size).toBe(0);
    const w = setup();
    await expect(w.run({ assets: [{ ...asset, sha256: digest }] })).rejects.toThrow(
      "model-download-digest",
    );
    expect(w.stored.size).toBe(0);
    await expect(
      w.run({ fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch }),
    ).rejects.toThrow("model-download-http-503");
  });
  test("confirmation failure and invalid download size fail closed", async () => {
    for (const confirm of [
      () => {
        throw Error("blocked UI");
      },
      async () => {
        throw Error("blocked UI");
      },
    ])
      await expect(setup({}).run({ confirm })).rejects.toBeInstanceOf(ModelDownloadBlocked);
    await expect(setup().run({ estimatedMb: 0 })).rejects.toBeInstanceOf(ModelDownloadBlocked);
    await expect(setup({ online: false }).run({ confirm: () => true })).rejects.toBeInstanceOf(
      ModelDownloadBlocked,
    );
  });
});

test("KWS has a complete manifest and never starts a Worker after a blocked preparation/disposal", async () => {
  expect(KWS_ASSETS).toHaveLength(4);
  expect(KWS_ASSETS.map((a) => a.url).some((u) => u.endsWith("preload.js.metadata"))).toBe(true);
  let made = 0;
  const worker = () => {
    made++;
    return {} as WorkerLike;
  };
  const blocked = createKws({
    worker,
    prepare: async () => {
      throw new ModelDownloadBlocked();
    },
  });
  await expect(blocked.load()).rejects.toBeInstanceOf(ModelDownloadBlocked);
  expect(made).toBe(0);
  expect(blocked.state()).toBe("needs-wifi");
  blocked.dispose();
  let done!: (assets: []) => void;
  const late = createKws({
    worker,
    prepare: () =>
      new Promise((r) => {
        done = r;
      }),
  });
  const loading = late.load();
  await Bun.sleep(1);
  late.dispose();
  done([]);
  await expect(loading).rejects.toBeInstanceOf(ModelDownloadBlocked);
  expect(made).toBe(0);
  expect(late.state()).toBe("idle");
});

test("download confirmation has translator context and all sixteen locales keep the size and distinct copy", () => {
  const keys = [
    "modelDownloadConfirm",
    "modelDownloadSttConfirm",
    "modelDownloadTitleWake",
    "modelDownloadTitleStt",
    "modelDownloadAllow",
    "modelDownloadCancel",
    "modelDownloadWaiting",
  ] as const;
  for (const key of keys) {
    expect(EXTRA_CONTEXT[key].split(/\s+/).length).toBeGreaterThan(5);
  }
  expect(EXTRA_CONTEXT.modelDownloadConfirm).toContain("{mb}");
  expect(EXTRA_CONTEXT.modelDownloadSttConfirm).toContain("{mb}");
  for (const locale of CHAT_LOCALES) {
    const e = EXTRA[locale];
    expect(e.modelDownloadConfirm).toContain("{mb}");
    expect(e.modelDownloadSttConfirm).toContain("{mb}");
    expect(e.modelDownloadSttConfirm).not.toBe(e.modelDownloadConfirm);
    expect(e.modelDownloadTitleWake.trim().length).toBeGreaterThan(2);
    expect(e.modelDownloadTitleStt.trim().length).toBeGreaterThan(2);
    expect(e.modelDownloadTitleStt).not.toBe(e.modelDownloadTitleWake);
    expect(e.modelDownloadAllow.trim().length).toBeGreaterThan(1);
    expect(e.modelDownloadCancel.trim().length).toBeGreaterThan(1);
    expect(e.modelDownloadAllow).not.toBe(e.modelDownloadCancel);
    expect(e.modelDownloadWaiting.length).toBeGreaterThan(10);
  }
  expect(EXTRA.en.modelDownloadSttConfirm.toLowerCase()).not.toContain("wake");
  expect(EXTRA.en.modelDownloadTitleStt.toLowerCase()).not.toContain("wake");
  expect(EXTRA.zh.modelDownloadSttConfirm).not.toContain("唤醒词");
  expect(EXTRA.zh.modelDownloadTitleStt).not.toContain("唤醒词");
});

async function withDom<T>(
  lang: string,
  fn: (ctx: {
    win: InstanceType<(typeof import("happy-dom"))["Window"]>;
    q: (selector: string) => HTMLElement | null;
    btn: (selector: string) => HTMLButtonElement;
    setVisibility: (state: "visible" | "hidden") => void;
    confirmCalls: () => number;
    alertCalls: () => number;
  }) => Promise<T>,
): Promise<T> {
  const { Window } = await import("happy-dom");
  const win = new Window();
  win.document.documentElement.lang = lang;
  let vis: "visible" | "hidden" = "visible";
  Object.defineProperty(win.document, "visibilityState", {
    get: () => vis,
    configurable: true,
  });
  let confirms = 0;
  let alerts = 0;
  const dialogs = win as unknown as { confirm: () => boolean; alert: () => void };
  dialogs.confirm = () => {
    confirms++;
    throw new Error("window.confirm must never be called");
  };
  dialogs.alert = () => {
    alerts++;
    throw new Error("window.alert must never be called");
  };
  const restore = stubGlobals({
    window: win,
    document: win.document,
  });
  const q = (selector: string) =>
    win.document.querySelector(selector) as unknown as HTMLElement | null;
  const btn = (selector: string) => {
    const el = win.document.querySelector(selector) as unknown as HTMLButtonElement | null;
    if (!el) throw new Error(`missing element: ${selector}`);
    return el;
  };
  try {
    return await fn({
      win,
      q,
      btn,
      setVisibility: (state) => {
        vis = state;
      },
      confirmCalls: () => confirms,
      alertCalls: () => alerts,
    });
  } finally {
    win.dispatchEvent(new win.Event("pagehide"));
    restore();
    await win.happyDOM.close();
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("in-app glass model download confirmation modal", () => {
  test("never uses window.confirm/alert; distinguishes wake vs stt copy, restores focus, and cleans up", async () => {
    await withDom("en", async ({ win, q, btn, confirmCalls, alertCalls }) => {
      const opener = win.document.createElement("button");
      opener.textContent = "Mic";
      win.document.body.appendChild(opener);
      opener.focus();

      // Wake download (default kind)
      const wakePromise = confirmBrowserModelDownload({ estimatedMb: 25 });
      await flush();
      expect(confirmCalls()).toBe(0);
      expect(alertCalls()).toBe(0);

      const overlay = q('[data-testid="model-download-modal"]')!;
      expect(overlay).not.toBeNull();
      const dialog = overlay.querySelector('[role="alertdialog"]') as unknown as HTMLElement;
      expect(dialog).not.toBeNull();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      const title = overlay.querySelector(
        '[data-testid="model-download-title"]',
      ) as unknown as HTMLElement;
      const body = overlay.querySelector(
        '[data-testid="model-download-body"]',
      ) as unknown as HTMLElement;
      const cancelBtn = btn('[data-testid="model-download-cancel"]');
      const allowBtn = btn('[data-testid="model-download-allow"]');
      const styleText = overlay.querySelector("style")?.textContent ?? "";
      expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
      expect(dialog.getAttribute("aria-describedby")).toBe(body.id);
      expect(title.textContent).toBe(EXTRA.en.modelDownloadTitleWake);
      expect(body.textContent).toContain("25 MB");
      expect(body.textContent?.toLowerCase()).toContain("wake");
      expect(cancelBtn.textContent).toBe(EXTRA.en.modelDownloadCancel);
      expect(allowBtn.textContent).toBe(EXTRA.en.modelDownloadAllow);
      expect(cancelBtn.type).toBe("button");
      expect(allowBtn.type).toBe("button");
      expect(cancelBtn.style.minHeight).toBe("44px");
      expect(allowBtn.style.minHeight).toBe("44px");
      expect(allowBtn.style.background).toContain("0.53 0.207 22.3");
      expect(overlay.style.zIndex).toBe("var(--lk-z-chat-modal, 90)");
      expect(styleText).toContain("max(16px, env(safe-area-inset-top))");
      expect(styleText).toContain(
        "oklch(from var(--background, oklch(0.98 0.005 85)) l c h / 0.88)",
      );
      expect(styleText).toContain("prefers-reduced-transparency: reduce");

      // Safe default focus is on Cancel; Tab traps strictly between Cancel and Allow
      expect(win.document.activeElement as unknown).toBe(cancelBtn);
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
      );
      expect(win.document.activeElement as unknown).toBe(allowBtn);
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
      );
      expect(win.document.activeElement as unknown).toBe(cancelBtn);
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
      );
      expect(win.document.activeElement as unknown).toBe(allowBtn);
      opener.focus();
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
      );
      expect(win.document.activeElement as unknown).toBe(cancelBtn);
      opener.focus();
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
      );
      expect(win.document.activeElement as unknown).toBe(allowBtn);

      // Clicking inside dialog panel does not dismiss
      dialog.click();
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();

      // Clicking Allow resolves true, removes modal, and restores focus
      allowBtn.click();
      expect(await wakePromise).toBe(true);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
      expect(win.document.activeElement).toBe(opener);

      // STT download uses distinct speech copy without wake words, in zh locale
      win.document.documentElement.lang = "zh-CN";
      const sttPromise = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();
      const sttTitle = q('[data-testid="model-download-title"]')!;
      const sttBody = q('[data-testid="model-download-body"]')!;
      expect(sttTitle.textContent).toBe(EXTRA.zh.modelDownloadTitleStt);
      expect(sttBody.textContent).toContain("70 MB");
      expect(sttBody.textContent).not.toContain("唤醒词");
      const sttCancel = btn('[data-testid="model-download-cancel"]');
      expect(sttCancel.textContent).toBe(EXTRA.zh.modelDownloadCancel);
      sttCancel.click();
      expect(await sttPromise).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
      expect(confirmCalls()).toBe(0);
      expect(alertCalls()).toBe(0);
    });
  });

  test("panel fits short viewports and large text: copy scrolls, Download/Cancel stay reachable", async () => {
    await withDom("en", async ({ win, q, btn }) => {
      // Short landscape phone with very large text
      win.happyDOM.setViewport({ width: 640, height: 280 });
      win.document.documentElement.style.fontSize = "32px";
      const p = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();
      const overlay = q('[data-testid="model-download-modal"]')!;
      const panel = q('[data-testid="model-download-panel"]')!;
      const scroll = q('[data-testid="model-download-scroll"]')!;
      const actions = q('[data-testid="model-download-actions"]')!;
      const styleText = overlay.querySelector("style")?.textContent ?? "";
      const panelRule =
        styleText.match(/\[data-testid="model-download-panel"\]\s*\{[^}]*\}/)?.[0] ?? "";

      // Panel is capped to the viewport (dvh with vh fallback) and can scroll itself as a last resort
      expect(panelRule).toContain("max-height: calc(100vh - 32px)");
      expect(panelRule).toContain("max-height: min(100%, calc(100dvh - 32px))");
      expect(panelRule).toContain("overflow-y: auto");
      expect(panel.style.overflowY).toBe("auto");
      expect(panel.style.minHeight).toBe("0");
      expect(panel.style.flexDirection).toBe("column");

      // Title and body live in a shrinkable scroll region; the button row never shrinks
      expect(scroll.contains(q('[data-testid="model-download-title"]') as unknown as Node)).toBe(
        true,
      );
      expect(scroll.contains(q('[data-testid="model-download-body"]') as unknown as Node)).toBe(
        true,
      );
      expect(scroll.style.overflowY).toBe("auto");
      expect(scroll.style.minHeight).toBe("0");
      expect(scroll.style.flexShrink).toBe("1");
      expect(actions.parentElement as unknown).toBe(panel);
      expect(panel.lastElementChild as unknown).toBe(actions);
      expect(actions.style.flexShrink).toBe("0");
      expect(actions.contains(btn('[data-testid="model-download-allow"]') as unknown as Node)).toBe(
        true,
      );
      expect(
        actions.contains(btn('[data-testid="model-download-cancel"]') as unknown as Node),
      ).toBe(true);

      // Still operable in this layout
      btn('[data-testid="model-download-allow"]').click();
      expect(await p).toBe(true);
    });
  });

  test("dismisses cleanly on backdrop click, Escape, visibilitychange, pagehide, and signal abort", async () => {
    await withDom("en", async ({ win, q, setVisibility }) => {
      // Backdrop click
      const pBackdrop = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();
      q('[data-testid="model-download-modal"]')!.click();
      expect(await pBackdrop).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();

      // Escape key (unrelated key does not dismiss)
      const pEsc = confirmBrowserModelDownload({ estimatedMb: 25, kind: "wake" });
      await flush();
      win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", cancelable: true }));
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();
      win.document.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      expect(await pEsc).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();

      // visibilitychange -> visible keeps open; -> hidden dismisses
      const pVis = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();
      win.document.dispatchEvent(new win.Event("visibilitychange"));
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();
      setVisibility("hidden");
      win.document.dispatchEvent(new win.Event("visibilitychange"));
      expect(await pVis).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
      setVisibility("visible");

      // pagehide
      const pHide = confirmBrowserModelDownload({ estimatedMb: 25 });
      await flush();
      win.dispatchEvent(new win.Event("pagehide"));
      expect(await pHide).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();

      // AbortSignal
      const ac = new AbortController();
      const pAbort = confirmBrowserModelDownload({
        estimatedMb: 70,
        kind: "stt",
        signal: ac.signal,
      });
      await flush();
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();
      ac.abort();
      expect(await pAbort).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
    });
  });

  test("network drop during downloadModelAssets auto-dismisses the open glass modal immediately", async () => {
    await withDom("en", async ({ q }) => {
      const h = setup({ connection: { type: "cellular" } });
      const task = h.run({
        estimatedMb: 70,
        confirm: (details) => confirmBrowserModelDownload({ ...details, kind: "stt" }),
      });
      await flush();
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();
      expect(q('[data-testid="model-download-title"]')?.textContent).toBe(
        EXTRA.en.modelDownloadTitleStt,
      );
      // Network goes offline while the modal is open
      h.events.dispatchEvent(new Event("offline"));
      await expect(task).rejects.toBeInstanceOf(ModelDownloadBlocked);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
      expect(h.calls).toHaveLength(0);

      // Network switches to Save-Data while modal is open
      const h2 = setup({ connection: { type: "cellular" } });
      const task2 = h2.run({
        estimatedMb: 70,
        confirm: (details) => confirmBrowserModelDownload({ ...details, kind: "stt" }),
      });
      await flush();
      expect(q('[data-testid="model-download-modal"]')).not.toBeNull();
      h2.change({ connection: { type: "cellular", saveData: true } });
      await expect(task2).rejects.toBeInstanceOf(ModelDownloadBlocked);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
      expect(h2.calls).toHaveLength(0);
    });
  });

  test("fails closed without mounting when hidden, pre-aborted, or DOM is unavailable", async () => {
    await withDom("en", async ({ q, setVisibility }) => {
      setVisibility("hidden");
      expect(await confirmBrowserModelDownload({ estimatedMb: 25 })).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();

      setVisibility("visible");
      const ac = new AbortController();
      ac.abort();
      expect(
        await confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt", signal: ac.signal }),
      ).toBe(false);
      expect(q('[data-testid="model-download-modal"]')).toBeNull();
    });

    // Missing document.body / createElement
    const restoreNoBody = stubGlobals({
      document: { visibilityState: "visible", body: null, createElement: () => ({}) },
    });
    try {
      expect(await confirmBrowserModelDownload({ estimatedMb: 25 })).toBe(false);
    } finally {
      restoreNoBody();
    }

    const restoreNoCreate = stubGlobals({
      document: { visibilityState: "visible", body: {} },
    });
    try {
      expect(await confirmBrowserModelDownload({ estimatedMb: 25 })).toBe(false);
    } finally {
      restoreNoCreate();
    }
  });

  test("serializes concurrent confirmation calls so two modals never stack", async () => {
    await withDom("en", async ({ win, q, btn, setVisibility }) => {
      const first = confirmBrowserModelDownload({ estimatedMb: 25, kind: "wake" });
      const second = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();

      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(1);
      expect(q('[data-testid="model-download-title"]')?.textContent).toBe(
        EXTRA.en.modelDownloadTitleWake,
      );

      btn('[data-testid="model-download-allow"]').click();
      expect(await first).toBe(true);
      await flush();

      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(1);
      expect(q('[data-testid="model-download-title"]')?.textContent).toBe(
        EXTRA.en.modelDownloadTitleStt,
      );

      btn('[data-testid="model-download-cancel"]').click();
      expect(await second).toBe(false);
      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(0);

      // A queued call whose signal aborts resolves false immediately without mounting
      const ac = new AbortController();
      const third = confirmBrowserModelDownload({ estimatedMb: 25, kind: "wake" });
      const fourth = confirmBrowserModelDownload({
        estimatedMb: 70,
        kind: "stt",
        signal: ac.signal,
      });
      await flush();
      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(1);
      ac.abort();
      expect(await fourth).toBe(false);
      // Third modal is still open and resolves normally
      expect(q('[data-testid="model-download-title"]')?.textContent).toBe(
        EXTRA.en.modelDownloadTitleWake,
      );
      btn('[data-testid="model-download-cancel"]').click();
      expect(await third).toBe(false);
      await flush();
      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(0);

      // A queued call when page becomes hidden re-checks visibility and fails closed without mounting
      const fifth = confirmBrowserModelDownload({ estimatedMb: 25, kind: "wake" });
      const sixth = confirmBrowserModelDownload({ estimatedMb: 70, kind: "stt" });
      await flush();
      setVisibility("hidden");
      win.document.dispatchEvent(new win.Event("visibilitychange"));
      expect(await fifth).toBe(false);
      expect(await sixth).toBe(false);
      expect(win.document.querySelectorAll('[data-testid="model-download-modal"]')).toHaveLength(0);
    });
  });
});

test("browser defaults guard the real fetch on unmetered network without a microphone", async () => {
  let calls = 0;
  const restore = stubGlobals({
    navigator: { connection: { type: "wifi" }, onLine: true },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    caches: {
      open: async () => ({
        match: async () => undefined,
        put: async () => {},
        delete: async () => true,
      }),
    },
    fetch: async () => {
      calls++;
      return new Response("fixture");
    },
  });
  try {
    expect(browserModelNetwork().connection?.type).toBe("wifi");
    await downloadModelAssets({ assets: [asset], cacheName: "fixture", estimatedMb: 25 });
    expect(calls).toBe(1);
  } finally {
    restore();
  }
});

test("cache read/delete/write failures do not bypass network consent or turn storage into a requirement", async () => {
  const h = setup({});
  await expect(
    h.run({
      cache: async () =>
        ({
          match: async () => {
            throw Error("read");
          },
          put: async () => {},
          delete: async () => true,
        }) as Pick<Cache, "match" | "put" | "delete">,
    }),
  ).rejects.toBeInstanceOf(ModelDownloadBlocked);
  expect(h.calls).toHaveLength(0);
  const bytes = new TextEncoder().encode("valid");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const w = setup();
  const out = await w.run({
    assets: [{ ...asset, sha256: digest }],
    fetch: (async () => new Response(bytes)) as unknown as typeof fetch,
    cache: async () =>
      ({
        match: async () => new Response("corrupt"),
        delete: async () => {
          throw Error("delete");
        },
        put: async () => {
          throw Error("quota");
        },
      }) as Pick<Cache, "match" | "put" | "delete">,
  });
  expect(new TextDecoder().decode(out[0].bytes)).toBe("valid");
  expect(out[0].downloaded).toBe(true);
});

test("the real generated Worker serves only prepared WASM bytes and cannot fetch around the guard", async () => {
  const self: { fetch?: typeof fetch; onmessage?: unknown } = {};
  const src = workerSource({
    base: "https://models.example/",
    glue: "glue.js",
    model: "https://models.example/",
    sha: {},
    cache: "fixture",
  });
  const seed = new Function("self", src + ";return (bytes)=>prepared.set(wasmUrl,{bytes});")(
    self,
  ) as (b: ArrayBuffer) => void;
  await expect(self.fetch!("https://models.example/prebuilt/kws.wasm")).rejects.toThrow(
    "not prepared",
  );
  seed(new Uint8Array([1, 2, 3]).buffer);
  for (const input of [
    "https://models.example/prebuilt/kws.wasm",
    new URL("https://models.example/prebuilt/kws.wasm"),
    new Request("https://models.example/prebuilt/kws.wasm"),
  ]) {
    const response = await self.fetch!(input);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  }
  await expect(self.fetch!("https://models.example/unlisted-model")).rejects.toThrow(
    "unprepared model request",
  );
});
