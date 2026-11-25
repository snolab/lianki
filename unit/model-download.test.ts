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
    expect(shown).toEqual({ estimatedMb: 25, risk: "restricted" });
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

test("download confirmation has translator context and all sixteen locales keep the size", () => {
  expect(EXTRA_CONTEXT.modelDownloadConfirm).toContain("{mb}");
  for (const locale of CHAT_LOCALES) {
    expect(EXTRA[locale].modelDownloadConfirm).toContain("{mb}");
    expect(EXTRA[locale].modelDownloadWaiting.length).toBeGreaterThan(10);
  }
});

test("browser defaults guard the real fetch and localized confirmation without a microphone", async () => {
  let prompt = "";
  let calls = 0;
  const restore = stubGlobals({
    navigator: { connection: { type: "wifi" }, onLine: true },
    document: { visibilityState: "visible", documentElement: { lang: "zh" } },
    window: {
      confirm: (text: string) => {
        prompt = text;
        return false;
      },
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
    expect(confirmBrowserModelDownload({ estimatedMb: 25 })).toBe(false);
    expect(prompt).toContain("25 MB");
    expect(prompt).toContain("取消");
    await downloadModelAssets({ assets: [asset], cacheName: "fixture", estimatedMb: 25 });
    expect(calls).toBe(1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    prompt = "";
    expect(confirmBrowserModelDownload({ estimatedMb: 25 })).toBe(false);
    expect(prompt).toBe("");
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
