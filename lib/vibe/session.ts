// One /vibe conversation on the page (docs/vibe.md), with everything that
// touches the browser injected, so it is unit-tested with the real mic core
// (createMic: VAD handling, cleanTranscript, the silence guard's judgeFinal) on
// a fake VAD and a fake Mac.
//
// What this session is careful about:
// - It starts only from start({tap: true}), which the start page's button calls; the server is asked first, so a refusal never opens the microphone.
// - The text goes to `api.lines` and nowhere else: no chat, no command taps, no
//   clip sink, no cue, no cloud fallback. This file imports none of them.
// - Pausing stops the feed at once: the tracks stop, the utterance under way is
//   dropped, the socket closes. A final that lands later belongs to an old run
//   and is thrown away; the server refuses lines while paused as well.
// - A hidden page, no network, a lost Mac or a lost microphone pause it visibly.
//   Only a tap resumes.
import {
  createMic,
  type MicState,
  type StreamStt,
  type UploadInfo,
  type Vad,
  type VadEvents,
} from "@lianki/debug-chat/mic";
import { localSttRoute, needsTicket, type LocalState } from "@lianki/debug-chat/local-stt";

/**
 * Where /vibe's audio may go: the owner's routes without the public tunnel,
 * whose TLS ends at Cloudflare's edge, which would see the audio in clear
 * (docs/local-stt.md, "Trade-offs"). "Audio stays on the owner's Mac" leaves
 * the tailnet (end to end), or localhost. Null: no such route on this page.
 */
export function vibeRoute(stored: string | null | undefined): string | null {
  const { urls } = localSttRoute(stored, true);
  const kept = (urls ?? "").split(" ").filter((u) => u && !needsTicket(u));
  return kept.length ? kept.join(" ") : null;
}

export type VibeStatus = "idle" | "starting" | "running" | "paused" | "stopped";
/** Why it is paused. "user": his tap; the rest stopped by themselves and say so. */
export type PauseReason = "user" | "hidden" | "offline" | "stt" | "mic" | "server";
/** Why it ended, when it did not end by his tap. */
export type EndReason = "not-tapped" | "refused" | "no-stt" | "no-mic" | "full" | "gone" | "user";

export type VibeLine = { text: string; lang?: string };

export type VibeView = {
  status: VibeStatus;
  pause?: PauseReason;
  end?: EndReason;
  lines: readonly VibeLine[];
  /** The utterance being heard, dimmed: never stored. */
  interim: string;
  /** Finals the Mac failed to give: dropped, never sent to a cloud instead. */
  lost: number;
  /** The /read material, once the first line is stored. */
  material: string | null;
  /** The conversation's id: its address, /vibe/<id>. */
  doc?: string | null;
};

export type ApiResult<T> = ({ ok: true } & T) | { ok: false; status: number };

export type VibeApi = {
  start(b: { tap: true; title: string }): Promise<ApiResult<{ id: string }>>;
  lines(
    id: string,
    b: { from: number; lines: string[] },
    keepalive: boolean,
  ): Promise<ApiResult<{ next: number; material: string | null; langs: string[] }>>;
  state(
    id: string,
    state: "running" | "paused" | "stopped",
    keepalive: boolean,
  ): Promise<ApiResult<object>>;
};

export type TrackLike = { stop(): void; readyState?: string; onended?: unknown };
export type StreamLike = { getTracks(): TrackLike[] };

/** The Mac (local-stt.ts createLocalStt): what a session uses of it. */
export type VibeStt = StreamStt & {
  warm(): void;
  keep(on: boolean): void;
  close(): void;
  state(): LocalState;
  subscribe(f: (s: LocalState) => void): () => void;
};

export type VibeDeps = {
  api: VibeApi;
  /** A new client for the Mac's tailnet route; null when this page has no route. */
  stt(): VibeStt | null;
  getStream(): Promise<StreamLike>;
  load(ev: VadEvents, stream: StreamLike): Promise<Vad>;
  fallback?(ev: VadEvents, stream: StreamLike): Promise<Vad>;
  /** The chat's mic stays out while this runs (mic-taps.ts block): returns the release. */
  holdChatMic(): () => void;
  /** The page going hidden or the network going away; returns an unsubscribe. */
  watchPage(f: (why: "hidden" | "offline") => void): () => void;
  /** The page is hidden right now (it may have gone so while starting). */
  isHidden?(): boolean;
  /** How long to wait for the Mac before saying it cannot be reached. */
  readyMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onView(v: VibeView): void;
  /** Events only: a count or a reason, never text. */
  log?(ev: Record<string, unknown>): void;
  /** The speech server served an utterance of `audioMs`: booked in the cost ledger (docs/payments.md, "Cost ledger"). */
  served?(audioMs: number): void;
};

/** Longer than the socket race's own deadline (local-stt.ts CONNECT_TIMEOUT_MS). */
const READY_MS = 3_000;

export function createVibeSession(d: VibeDeps) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let view: VibeView = {
    status: "idle",
    lines: [],
    interim: "",
    lost: 0,
    material: null,
  };
  const emit = (patch: Partial<VibeView>) => {
    view = { ...view, ...patch };
    d.onView(view);
  };

  let id: string | null = null;
  /** Bumped whenever the feed stops: anything from an older run is dropped. */
  let run = 0;
  let mic: ReturnType<typeof createMic> | null = null;
  let stt: VibeStt | null = null;
  let unSub: (() => void) | null = null;
  let stream: StreamLike | null = null;
  let releaseChat: (() => void) | null = null;
  let unwatch: (() => void) | null = null;

  /** Lines heard and not yet acknowledged, the first of them at index `sent`. */
  const queue: { index: number; text: string }[] = [];
  let sent = 0;
  let total = 0;
  /** Lines the page was opened with that a line number on the server counts past. */
  let seqBase = 0;
  let pumping: Promise<void> | null = null;
  let keepalive = false;
  /** Ending: a failure on the last send is not a pause. */
  let ending = false;

  const stopStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  };

  /** Everything that hears stops, now. Text already heard stays in the queue. */
  const stopFeed = async () => {
    run++;
    const m = mic;
    const c = stt;
    mic = null;
    stt = null;
    unSub?.();
    unSub = null;
    stopStream();
    emit({ interim: "" });
    if (m) {
      // Held first, so what the VAD hands over on its way down is dropped, not sent.
      m.hold(true);
      await m.off();
    }
    c?.keep(false);
    c?.close();
  };

  /** Send what is queued, one request at a time, in order. */
  const pump = (): Promise<void> => {
    pumping ??= (async () => {
      // A turn first, or `finally` would clear `pumping` before it is assigned.
      await Promise.resolve();
      try {
        while (queue.length && id) {
          const batch = queue.slice(0, 100);
          const r = await d.api.lines(
            id,
            { from: batch[0].index, lines: batch.map((l) => l.text) },
            keepalive,
          );
          if (!r.ok) return await onLinesRefused(r.status);
          queue.splice(0, batch.length);
          sent = r.next;
          const lines = [...view.lines];
          r.langs.forEach((lang, i) => {
            const at = batch[batch.length - r.langs.length + i]?.index;
            if (at !== undefined && lines[at - seqBase])
              lines[at - seqBase] = { ...lines[at - seqBase], lang };
          });
          emit({ lines, material: r.material ?? view.material });
        }
      } catch {
        // The network: nothing was lost, it goes on the next resume.
        if (view.status === "running") void pause("server");
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  };

  const onLinesRefused = async (status: number) => {
    d.log?.({ ev: "vibe-lines-refused", status });
    if (status === 409 && view.status === "paused") return; // Paused here too: they wait for resume.
    if (status === 404 || status === 401 || status === 403) return end("refused");
    if (status === 409) return end("gone");
    if (status === 413) return end("full");
    if (view.status === "running") await pause("server");
  };

  const ready = (c: VibeStt) =>
    new Promise<boolean>((resolve) => {
      if (c.state() === "ready") return resolve(true);
      let off = () => {};
      const t = setTimer(() => {
        off();
        resolve(false);
      }, d.readyMs ?? READY_MS);
      off = c.subscribe((s) => {
        if (s !== "ready" && s !== "down") return;
        clearTimer(t);
        off();
        resolve(s === "ready");
      });
      c.warm();
    });

  /** The upload createMic asks for: the Mac's final or nothing, never the cloud. */
  const upload =
    (me: number) =>
    async (_wav: Uint8Array, info: UploadInfo): Promise<string> => {
      if (info.partial || !info.local || me !== run) return "";
      try {
        const f = await info.local;
        try {
          d.served?.(info.durationMs);
        } catch {}
        if (me !== run) return "";
        info.onSignals?.(f.signals);
        return f.text;
      } catch {
        if (me === run) emit({ lost: view.lost + 1 });
        d.log?.({ ev: "vibe-final-lost" });
        return "";
      }
    };

  /** Opens the Mac, then the microphone. False, and nothing left open, if either fails. */
  const open = async (): Promise<"ok" | "stt" | "mic" | "stale"> => {
    const me = ++run;
    const c = d.stt();
    if (!c) return "stt";
    stt = c;
    if (!(await ready(c))) {
      if (me === run) stt = null;
      c.close();
      return me === run ? "stt" : "stale";
    }
    if (me !== run) {
      c.close();
      return "stale";
    }
    let denied = false;
    const m = createMic({
      partials: false,
      stream: () => (me === run ? c : undefined),
      load: async (ev) => {
        const s = await d.getStream();
        // Paused or stopped while the browser opened it: never left running.
        if (me !== run) {
          for (const t of s.getTracks()) t.stop();
          throw new Error("stale");
        }
        stream = s;
        return d.load(ev, s);
      },
      fallback: d.fallback
        ? async (ev) => {
            stream ??= await d.getStream();
            return d.fallback!(ev, stream);
          }
        : undefined,
      upload: upload(me),
      onState: (_s: MicState) => {},
      onText: (text) => {
        if (me !== run) return;
        const index = total++;
        queue.push({ index, text });
        emit({ lines: [...view.lines, { text }], interim: "" });
        void pump();
      },
      onPending: (_n, interim) => {
        if (me === run) emit({ interim });
      },
      onError: (e) => {
        denied = true;
        // The error's name and message are the browser's, never anything heard.
        d.log?.({ ev: "vibe-mic-error", error: String(e).slice(0, 200) });
      },
      log: d.log,
    });
    mic = m;
    unSub = c.subscribe((s) => {
      if (s === "down" && me === run && view.status === "running") void pause("stt");
    });
    await m.toggle();
    if (me !== run) return "stale";
    if (m.state() === "off" || denied) {
      await stopFeed();
      return "mic";
    }
    // The microphone itself going away (a call, unplugged) is a pause too.
    for (const t of stream?.getTracks() ?? [])
      t.onended = () => {
        if (me === run && view.status === "running") void pause("mic");
      };
    return "ok";
  };

  const finish = (reason: EndReason) => {
    releaseChat?.();
    releaseChat = null;
    unwatch?.();
    unwatch = null;
    emit({ status: "stopped", pause: undefined, end: reason, interim: "" });
  };

  /** The conversation is over from the server's side, or his Stop. */
  async function end(reason: EndReason) {
    ending = true;
    await stopFeed();
    const was = id;
    if (reason === "user") {
      keepalive = true;
      await pump().catch(() => {});
    }
    id = null;
    if (was) await d.api.state(was, "stopped", true).catch(() => null);
    finish(reason);
  }

  async function pause(reason: PauseReason) {
    if (view.status !== "running" || ending) return;
    emit({ status: "paused", pause: reason });
    keepalive = reason === "hidden";
    await stopFeed();
    if (reason !== "server" && reason !== "offline") await pump().catch(() => {});
    const was = id;
    if (was && reason !== "offline") await d.api.state(was, "paused", keepalive).catch(() => null);
  }

  /** With the conversation open on the server: the chat's mic out, then the Mac and the mic. */
  async function begin(): Promise<void> {
    releaseChat = d.holdChatMic();
    const got = await open();
    // Stopped while opening (the page left): `end` has said everything already.
    if (got === "stale") return;
    if (got !== "ok") {
      const was = id;
      id = null;
      if (was) await d.api.state(was, "stopped", false).catch(() => null);
      return finish(got === "mic" ? "no-mic" : "no-stt");
    }
    emit({ status: "running" });
    unwatch = d.watchPage((why) => void pause(why));
    if (d.isHidden?.()) void pause("hidden");
  }

  return {
    view: () => view,
    /**
     * The start page's button. Nothing else starts a conversation. Without the
     * tap, or with the server refusing, the microphone is never asked for.
     */
    async start(o: { tap: boolean; title: string }): Promise<void> {
      if (view.status === "starting" || view.status === "running" || view.status === "paused")
        return;
      if (o.tap !== true) return emit({ status: "stopped", end: "not-tapped" });
      view = { status: "starting", lines: [], interim: "", lost: 0, material: null };
      d.onView(view);
      queue.length = 0;
      ending = false;
      sent = 0;
      total = 0;
      seqBase = 0;
      const r = await d.api
        .start({ tap: true, title: o.title })
        .catch(() => ({ ok: false as const, status: 0 }));
      if (!r.ok) return emit({ status: "stopped", end: "refused" });
      id = r.id;
      emit({ doc: r.id });
      await begin();
    },
    /**
     * The log page's Keep going: more of the same conversation, by a tap as Start
     * is. The server is asked first, so a refusal never opens the microphone.
     */
    async continueDoc(o: {
      tap: boolean;
      id: string;
      material: string | null;
      lines: VibeLine[];
      next: number;
    }): Promise<void> {
      if (view.status === "starting" || view.status === "running" || view.status === "paused")
        return;
      if (o.tap !== true) return;
      view = {
        status: "starting",
        lines: o.lines,
        interim: "",
        lost: 0,
        material: o.material,
        doc: o.id,
      };
      d.onView(view);
      queue.length = 0;
      ending = false;
      keepalive = false;
      sent = o.next;
      total = o.next;
      seqBase = o.next - o.lines.length;
      const r = await d.api.state(o.id, "running", false).catch(() => null);
      if (!r?.ok) return emit({ status: "stopped", end: "refused" });
      id = o.id;
      await begin();
    },
    /** His tap on Pause. */
    pause: () => pause("user"),
    /** His tap on Resume: never by itself. */
    async resume(): Promise<void> {
      if (view.status !== "paused" || !id) return;
      keepalive = false;
      const r = await d.api.state(id, "running", false).catch(() => null);
      if (!r) return void emit({ pause: "server" });
      if (!r.ok) return end(r.status === 409 ? "gone" : "refused");
      const got = await open();
      if (got === "stale") return;
      if (got !== "ok") {
        emit({ pause: got });
        if (id) await d.api.state(id, "paused", false).catch(() => null);
        return;
      }
      emit({ status: "running", pause: undefined });
      void pump();
    },
    /** His tap on Stop; also when the page goes away. */
    stop: () => {
      if (view.status === "idle" || view.status === "stopped") return Promise.resolve();
      return end("user");
    },
    /** Back to the start page after a stop. */
    reset() {
      if (view.status !== "stopped") return;
      view = { status: "idle", lines: [], interim: "", lost: 0, material: null };
      d.onView(view);
    },
    /** How many lines the server has. For the tests and the page's own counter. */
    sent: () => sent,
  };
}
