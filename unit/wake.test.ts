import { describe, expect, it } from "bun:test";
import {
  LINKY,
  MIN_REQUEST_MS,
  REJECTS_TO_PASSIVE,
  afterKeyword,
  createWake,
  isWakeCommand,
  keywordEnd,
  type WakeSpot,
} from "@lianki/debug-chat/wake";
import {
  KWS_SHA256,
  TAIL_PAD_S,
  type WorkerLike,
  createKws,
  mayDownload,
  padForSpot,
  workerSource,
} from "@lianki/debug-chat/wake-kws";
import { type StreamStt, type VadEvents, createMic } from "@lianki/debug-chat/mic";
import { type MicDeps, createMicSession } from "@lianki/debug-chat/mic-session";
import { parseControllerMessage } from "@/lib/dev-eval";
import { wakeStrings } from "@lianki/debug-chat/ui-strings";

const tick = () => new Promise((r) => setTimeout(r, 0));
const RATE = 16_000;

describe("the wake state machine", () => {
  it("starts active; REJECTS_TO_PASSIVE rejections in a row make it passive", () => {
    const seen: string[] = [];
    const w = createWake({ onChange: (v, from, why) => seen.push(`${from}→${v.mode} ${why}`) });
    expect(w.mode()).toBe("active");
    for (let i = 1; i < REJECTS_TO_PASSIVE; i++) expect(w.reject()).toBe(false);
    expect(w.view()).toEqual({ mode: "active", rejects: REJECTS_TO_PASSIVE - 1 });
    expect(w.reject()).toBe(true);
    expect(w.mode()).toBe("passive");
    expect(seen).toEqual(["active→passive rejects"]);
    // Passive: further rejections change nothing.
    expect(w.reject()).toBe(false);
  });

  it("an accepted utterance resets the count", () => {
    const w = createWake();
    w.reject();
    w.reject();
    w.accept();
    w.reject();
    w.reject();
    expect(w.mode()).toBe("active");
  });

  it("the wake word, a tap or the agent set it; the same mode again is no change", () => {
    const seen: string[] = [];
    const w = createWake({ onChange: (v, _f, why) => seen.push(`${v.mode} ${why}`) });
    expect(w.set("passive", "agent")).toBe(true);
    expect(w.set("passive", "agent")).toBe(false);
    expect(w.set("active", "wake-word")).toBe(true);
    expect(seen).toEqual(["passive agent", "active wake-word"]);
  });

  it("knows the chat lane's commands", () => {
    expect(["active", "passive", "ignored"].every(isWakeCommand)).toBe(true);
    expect(isWakeCommand("asleep")).toBe(false);
  });
});

describe("the keyword and the cut after it", () => {
  it("LINKY: English phones and pinyin readings, all distinct", () => {
    const seqs = LINKY.matches.map((m) => m.tokens.join(" "));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toContain("L IH1 NG K IY0");
    expect(seqs).toContain("l ín q í");
  });

  it("cuts after the keyword's last token; a bare wake has no rest", () => {
    const audio = new Float32Array(RATE * 3);
    const d = {
      label: "LINKY",
      startTime: 0,
      timestamps: [0.5, 0.6, 0.7, 0.8, 1.0],
      tokens: ["L"],
    };
    expect(keywordEnd(d)).toBe(1);
    const r = afterKeyword(audio, [d], RATE) as Extract<WakeSpot, { hit: true }>;
    expect(r.hit).toBe(true);
    expect(r.rest.length).toBe(RATE * 2);
    const bare = afterKeyword(audio.subarray(0, RATE * 1.2), [d], RATE) as Extract<
      WakeSpot,
      { hit: true }
    >;
    expect(bare.rest.length).toBe(0); // 200 ms < MIN_REQUEST_MS
    expect(MIN_REQUEST_MS).toBeGreaterThan(200);
    expect(afterKeyword(audio, [], RATE)).toEqual({ hit: false });
  });

  it("pads for the spotter: clamped, NaN-free, with a silent tail", () => {
    const p = padForSpot(new Float32Array([2, -3, Number.NaN, 0.5]));
    expect([...p.subarray(0, 4)]).toEqual([1, -1, 0, 0.5]);
    expect(p.length).toBe(4 + TAIL_PAD_S * RATE);
  });
});

describe("the first download waits for Wi-Fi", () => {
  it("cellular or Save-Data with nothing cached: no; cached, Wi-Fi or unknown: yes", async () => {
    const no = async () => false;
    const yes = async () => true;
    expect(await mayDownload({ connection: { type: "cellular" } }, no)).toBe(false);
    expect(await mayDownload({ connection: { type: "wifi", saveData: true } }, no)).toBe(false);
    expect(await mayDownload({ connection: { type: "cellular" } }, yes)).toBe(true);
    expect(await mayDownload({ connection: { type: "wifi" } }, no)).toBe(true);
    expect(await mayDownload({}, no)).toBe(true); // Safari: no navigator.connection
  });
});

/** A Worker that answers like the real one, driven by the test. */
function fakeWorker(answer: (m: { type: string; id?: number }) => unknown) {
  const posted: { type: string }[] = [];
  let terminated = false;
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m) {
      posted.push(m as { type: string });
      const a = answer(m as { type: string; id?: number });
      if (a) queueMicrotask(() => w.onmessage?.({ data: a }));
    },
    terminate() {
      terminated = true;
    },
  };
  return { w, posted, terminated: () => terminated };
}

describe("createKws: the page side of the spotter", () => {
  it("loads once, spots, and reports a hit with the words after it", async () => {
    let made = 0;
    const states: string[] = [];
    const f = fakeWorker((m) =>
      m.type === "init"
        ? { type: "ready", ms: 5, downloaded: true }
        : {
            type: "spotted",
            id: m.id,
            ms: 3,
            hits: [{ label: "LINKY", startTime: 0, timestamps: [0.2, 0.5], tokens: ["L", "IY0"] }],
          },
    );
    const k = createKws({
      worker: () => (made++, f.w),
      allowed: async () => true,
      onState: (s) => states.push(s),
    });
    await Promise.all([k.load(), k.load()]);
    expect(made).toBe(1);
    const r = await k.spot(new Float32Array(RATE * 2));
    expect(r.hit).toBe(true);
    expect(r.hit && r.rest.length).toBe(RATE * 1.5);
    expect(states).toEqual(["loading", "ready"]);
    expect(f.posted.map((m) => m.type)).toEqual(["init", "spot"]);
  });

  it("a failed load is no hit, and can be retried", async () => {
    let fail = true;
    const k = createKws({
      worker: () =>
        fakeWorker((m) =>
          m.type === "init"
            ? fail
              ? { type: "failed", error: "digest mismatch" }
              : { type: "ready" }
            : { type: "spotted", id: m.id, hits: [] },
        ).w,
      allowed: async () => true,
    });
    expect(await k.spot(new Float32Array(10))).toEqual({ hit: false, error: "digest mismatch" });
    expect(k.state()).toBe("failed");
    fail = false;
    await k.load();
    expect(k.state()).toBe("ready");
  });

  it("on cellular nothing is fetched: needs-wifi", async () => {
    let made = 0;
    const k = createKws({
      worker: () => (made++, fakeWorker(() => null).w),
      allowed: async () => false,
    });
    await expect(k.load()).rejects.toThrow("needs-wifi");
    expect(k.state()).toBe("needs-wifi");
    expect(made).toBe(0);
  });

  it("a spot that never answers times out as no hit", async () => {
    const k = createKws({
      worker: () => fakeWorker((m) => (m.type === "init" ? { type: "ready" } : null)).w,
      allowed: async () => true,
      timeoutMs: 5,
    });
    expect(await k.spot(new Float32Array(10))).toMatchObject({ hit: false, error: "timeout" });
  });

  it("by default a Blob module Worker; a Worker that cannot start is a failed load; dispose", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { Worker: g.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    const made: { url: string; opts: unknown; src: string }[] = [];
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = (b: Blob) => {
      const u = `blob:test/${blobs.size}`;
      blobs.set(u, b);
      return u;
    };
    URL.revokeObjectURL = () => {};
    let refuse = false;
    g.Worker = class {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(url: string, opts: unknown) {
        if (refuse) throw new Error("no workers here");
        made.push({ url, opts, src: "" });
      }
      postMessage(m: { type: string }) {
        if (m.type === "init") queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
      }
      terminate() {}
    };
    try {
      const k = createKws({ allowed: async () => true });
      await k.load();
      expect(made[0]?.opts).toEqual({ type: "module", name: "lk-wake" });
      expect(await blobs.get(made[0].url)!.text()).toContain("crypto.subtle.digest");
      k.dispose();
      expect(k.state()).toBe("idle");
      refuse = true;
      const k2 = createKws({ allowed: async () => true });
      await expect(k2.load()).rejects.toThrow("no workers here");
      expect(k2.state()).toBe("failed");
      // The default check: no Cache API here, so "not cached".
      expect(await mayDownload({ connection: { type: "cellular" } })).toBe(false);
    } finally {
      g.Worker = saved.Worker;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
  });

  it("the worker pins every file it runs by SHA-256", () => {
    const src = workerSource({
      base: "B/",
      glue: "g.js",
      model: "M/",
      sha: KWS_SHA256,
      cache: "c",
    });
    expect(src).toContain("crypto.subtle.digest");
    expect(Object.keys(KWS_SHA256).some((u) => u.endsWith("kws.wasm"))).toBe(true);
    expect(Object.keys(KWS_SHA256).some((u) => u.endsWith("preload.data"))).toBe(true);
    expect(Object.values(KWS_SHA256).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
});

/** createMic with a fake VAD, uploads and wake gate. */
function gated(spot: (a: Float32Array) => Promise<WakeSpot>, stream?: () => StreamStt) {
  let ev: VadEvents | null = null;
  const uploads: { samples: number; echo: () => void; local?: Promise<unknown> }[] = [];
  const verdicts: string[] = [];
  const texts: string[] = [];
  let passive = true;
  let woke = 0;
  let answer = "what's next";
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async (wav, info) => {
      uploads.push({
        samples: (wav.length - 44) / 2,
        echo: () => info.onEcho?.(),
        local: info.local,
      });
      return answer;
    },
    stream,
    onState: () => {},
    onText: (t) => texts.push(t),
    onPending: () => {},
    wake: {
      passive: () => passive,
      spot,
      onWake: () => {
        woke++;
        passive = false;
      },
      verdict: (ok, why) => verdicts.push(`${ok} ${why}`),
    },
  });
  const say = (sec: number) => {
    ev!.onSpeechStart();
    ev!.onSpeechEnd(new Float32Array(Math.round(sec * RATE)));
  };
  return {
    mic,
    say,
    uploads,
    verdicts,
    texts,
    woke: () => woke,
    setPassive: (p: boolean) => void (passive = p),
    setAnswer: (a: string) => void (answer = a),
  };
}

describe("createMic with the wake gate", () => {
  it("passive: an utterance without Linky never leaves the phone", async () => {
    const g = gated(async () => ({ hit: false }));
    await g.mic.toggle();
    g.say(2);
    await tick();
    await tick();
    expect(g.uploads).toEqual([]);
    expect(g.texts).toEqual([]);
    expect(g.woke()).toBe(0);
  });

  it("passive: Linky wakes it, and only what follows is uploaded", async () => {
    const g = gated(async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["L"] }));
    await g.mic.toggle();
    g.say(3);
    await tick();
    await tick();
    expect(g.woke()).toBe(1);
    expect(g.uploads.map((u) => u.samples)).toEqual([RATE * 2]);
    await tick();
    expect(g.texts).toEqual(["what's next"]);
  });

  it("passive: the rest after Linky streams to the local STT when its socket is up", async () => {
    const calls: string[] = [];
    let up = true;
    const stt: StreamStt = {
      connected: () => up,
      begin: () => {
        calls.push("begin");
        return {
          frame: () => void calls.push("frame"),
          end: async (a) => {
            calls.push(`end ${a.length}`);
            return { text: "下一个", model: "local:sv", ms: 9, endToFinalMs: 20 };
          },
          cancel: () => void calls.push("cancel"),
        };
      },
    };
    const g = gated(
      async (a) => ({ hit: true, rest: a.subarray(RATE), tokens: ["L"] }),
      () => stt,
    );
    await g.mic.toggle();
    g.say(3);
    await tick();
    await tick();
    // Passive while heard: nothing streamed; then the whole utterance as pre-pad + end, the
    // text read from after "Linky" (textFrom) and the speaker check on all of it (Voiceprint).
    expect(calls).toEqual(["begin", `end ${RATE * 3}`]);
    expect(await g.uploads[0].local).toMatchObject({ text: "下一个" });
    // The socket down: the rest goes to the cloud alone, without waiting for a connect.
    up = false;
    g.setPassive(true);
    calls.length = 0;
    g.say(3);
    await tick();
    await tick();
    expect(calls).toEqual([]);
    expect(g.uploads[1].local).toBeUndefined();
  });

  it("passive: a bare Linky wakes it and uploads nothing", async () => {
    const g = gated(async () => ({ hit: true, rest: new Float32Array(0), tokens: ["L"] }));
    await g.mic.toggle();
    g.say(1);
    await tick();
    await tick();
    expect(g.woke()).toBe(1);
    expect(g.uploads).toEqual([]);
  });

  it("active: each final gets a verdict; an echo drop gets none", async () => {
    const g = gated(async () => ({ hit: false }));
    g.setPassive(false);
    await g.mic.toggle();
    g.say(1);
    await tick();
    g.setAnswer("");
    g.say(1);
    await tick();
    expect(g.verdicts).toEqual(["true ok", "false empty"]);
    // The upload marks its utterance as the agent's echo: no verdict.
    const g2 = gated(async () => ({ hit: false }));
    g2.setPassive(false);
    await g2.mic.toggle();
    const orig = g2.uploads;
    g2.setAnswer("");
    g2.say(1);
    orig[0].echo();
    await tick();
    expect(g2.verdicts).toEqual([]);
  });
});

describe("the mic session's wake mode", () => {
  function session(kwsOk = true) {
    let events: VadEvents | null = null;
    const logs: Record<string, unknown>[] = [];
    let onState: ((s: "idle" | "loading" | "ready" | "failed" | "needs-wifi") => void) | null =
      null;
    let loads = 0;
    const deps: MicDeps = {
      getStream: async () => ({ id: "s", getTracks: () => [{ readyState: "live", stop() {} }] }),
      load: async (ev) => {
        events = ev;
        return { start() {}, pause() {}, flush() {}, destroy() {} };
      },
      upload: async () => "",
      log: (ev) => void logs.push(ev),
      kws: (f) => {
        onState = f;
        return {
          load: async () => {
            loads++;
            f("loading");
            f(kwsOk ? "ready" : "failed");
            if (!kwsOk) throw new Error("no");
          },
          spot: async () => ({ hit: false }),
        };
      },
    };
    const s = createMicSession(deps);
    return { s, logs, events: () => events, loads: () => loads, onState: () => onState };
  }

  it("three empty transcripts make it passive and load the spotter once", async () => {
    const t = session();
    await t.s.toggle();
    for (let i = 0; i < REJECTS_TO_PASSIVE; i++) {
      t.events()!.onSpeechStart();
      t.events()!.onSpeechEnd(new Float32Array(RATE));
      await tick();
    }
    await tick();
    expect(t.s.view().wake).toBe("passive");
    expect(t.s.view().kws).toBe("ready");
    expect(t.loads()).toBe(1);
    expect(t.logs).toContainEqual({ ev: "wake", from: "active", to: "passive", reason: "rejects" });
  });

  it("the agent sets it; a tap while passive makes it active, not off", async () => {
    const t = session();
    await t.s.toggle();
    t.s.wake("passive");
    expect(t.s.view().wake).toBe("passive");
    await t.s.toggle();
    expect(t.s.view().state).not.toBe("off");
    expect(t.s.view().wake).toBe("active");
    await t.s.toggle();
    expect(t.s.view().state).toBe("off");
  });

  it("'ignored' from the agent counts as a rejection", async () => {
    const t = session();
    await t.s.toggle();
    for (let i = 0; i < REJECTS_TO_PASSIVE; i++) t.s.wake("ignored");
    expect(t.s.view().wake).toBe("passive");
  });

  it("never deaf: a spotter that cannot load puts it back to active", async () => {
    const t = session(false);
    await t.s.toggle();
    t.s.wake("passive");
    await tick();
    expect(t.s.view().wake).toBe("active");
    expect(t.s.view().kws).toBe("failed");
    expect(t.logs).toContainEqual({
      ev: "wake",
      from: "passive",
      to: "active",
      reason: "kws-failed",
    });
  });

  it("turning listening on again starts active", async () => {
    const t = session();
    await t.s.toggle();
    t.s.wake("passive");
    await t.s.off();
    await t.s.toggle();
    expect(t.s.view().wake).toBe("active");
  });
});

describe("the wake strings", () => {
  it("speak the page's language and keep Linky in Latin letters", () => {
    for (const lang of ["en", "zh-CN", "ja"]) {
      const s = wakeStrings(lang);
      expect(s.badge).toBe("Linky?");
      expect(s.passive).toContain("Linky");
    }
    expect(wakeStrings("zh").wifi).toContain("Wi-Fi");
    expect(wakeStrings("ja").loading).toBe("ウェイクワードを準備中…");
    expect(wakeStrings("fr").failed).toBe(wakeStrings("en").failed);
  });
});

describe("the chat lane's {type: wake}", () => {
  it("parses active, passive and ignored, with an optional thread", () => {
    expect(parseControllerMessage('{"type":"wake","mode":"passive"}')).toEqual({
      ok: true,
      value: { type: "wake", mode: "passive" },
    });
    expect(parseControllerMessage('{"type":"wake","mode":"ignored","to":"f1@x.com"}')).toEqual({
      ok: true,
      value: { type: "wake", mode: "ignored", to: "f1@x.com" },
    });
    expect(parseControllerMessage('{"type":"wake","mode":"on"}').ok).toBe(false);
  });
});
