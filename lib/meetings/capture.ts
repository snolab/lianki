"use client";

/**
 * The meeting recorder in the browser (docs/meetings.md, "Capture in the
 * browser"). A page singleton (`globalThis.__lkMeeting`), so moving between
 * Lianki pages keeps recording; a full reload ends it (its pieces in
 * IndexedDB are sent on the next visit to /my/meetings).
 *
 *   getDisplayMedia ─ video ─────────────────────┐
 *                   └ tab/system sound ─┬─ mix ──┼─▶ "av"     one continuous file, cut every chunkSec
 *   getUserMedia ──── mic ──────────────┤        │
 *                                       ├──────────▶ "me"     mic only, a new recorder per piece
 *                   tab/system sound ───┴──────────▶ "others" their sound only, a new recorder per piece
 *
 * Every time is on one clock: ms of recording from the meeting's start,
 * pauses excluded (`clock()`), so av pieces, me/others pieces, PCM offsets
 * and transcript lines line up with the video's own time.
 *
 * Live PCM hook (for live captions, the voice side): `onPcm(f)` gets
 * `{track, offset, samples}` frames of 16 kHz mono Float32 PCM for `me` and
 * `others`, `offset` the first sample's index from the meeting's start
 * (`offset / 16` = ms on the same clock). No recogniser is wired here.
 *
 * Nothing here plays sound: the mix goes to a MediaStreamAudioDestinationNode
 * for the recorder, never to the speakers.
 */
import {
  type AudioTrack,
  type Track,
  clusterTimecode,
  defaultTitle,
  firstFragment,
  parseMimePrefs,
  pickMime,
  sha256Hex,
} from "./core";
import { idbStore } from "./idb";
import { type PcmFrame, PcmHub, Resampler, toMono } from "./pcm";
import { type QueuedPiece, Uploader, sendPiece } from "./queue";

export type StopReason = "user" | "share-ended" | "max" | "quota" | "refused" | "error";
export type RecPhase = "idle" | "starting" | "recording" | "paused" | "stopping" | "ended";
export type RecState = {
  phase: RecPhase;
  meetingId: string | null;
  /** Recorded ms at the last state change, and the clock reading then (for the bar's ticking). */
  elapsedMs: number;
  bytes: number;
  waiting: number;
  micOn: boolean;
  micLost: boolean;
  roomAudio: boolean;
  reason: StopReason | null;
};

export type StartOptions = {
  mic: boolean;
  transcript: "none" | "local" | "cloud";
  /** The title's first word, in the page's language ("Meeting"). */
  titleWord: string;
  locale?: string;
  cfg: {
    chunkSec: number;
    maxMinutes: number;
    videoKbps: number;
    frameRate: number;
    audioKbps: number;
    trackKbps: number;
    mimeTypes: string;
  };
};

export type StartError = "unsupported" | "refused" | "cancelled" | "quota" | "failed";

const PCM_WORKLET = `
class P extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      this.buf.push(ch.map((c) => c.slice()));
      this.n += ch[0].length;
      if (this.n >= 2048) { this.port.postMessage(this.buf); this.buf = []; this.n = 0; }
    }
    return true;
  }
}
registerProcessor("lk-meeting-pcm", P);
`;

type Piece = Omit<QueuedPiece, "meeting" | "sha256" | "bytes" | "at"> & { blob: Blob };

class MeetingRecorder {
  private st: RecState = {
    phase: "idle",
    meetingId: null,
    elapsedMs: 0,
    bytes: 0,
    waiting: 0,
    micOn: false,
    micLost: false,
    roomAudio: false,
    reason: null,
  };
  private readonly listeners = new Set<(s: RecState) => void>();
  readonly pcm = new PcmHub();
  private uploader: Uploader | null = null;

  // one meeting's resources
  private t0 = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private display: MediaStream | null = null;
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  private av: MediaRecorder | null = null;
  private audioRec: Partial<Record<AudioTrack, MediaRecorder>> = {};
  private seq: Record<Track, number> = { av: 0, me: 0, others: 0 };
  private lastCut = 0;
  private mime = { av: "", audio: "" };
  private kbps = { track: 32 };
  private releaseMic: (() => void) | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void>[] = [];
  private titleObs: MutationObserver | null = null;
  private resamplers: Partial<Record<AudioTrack, Resampler>> = {};
  private nodes: AudioNode[] = [];

  get state(): RecState {
    return this.st;
  }
  subscribe(f: (s: RecState) => void): () => void {
    this.listeners.add(f);
    f(this.st);
    return () => void this.listeners.delete(f);
  }
  /** The live PCM hook (see the file comment). */
  onPcm(f: (frame: PcmFrame) => void): () => void {
    return this.pcm.on(f);
  }
  /** Recorded ms from the meeting's start, pauses excluded. */
  clock(): number {
    if (!this.t0) return 0;
    const now = this.pausedAt ?? performance.now();
    return Math.max(0, now - this.t0 - this.pausedTotal);
  }
  private set(p: Partial<RecState>) {
    this.st = { ...this.st, ...p, elapsedMs: this.clock() };
    for (const f of Array.from(this.listeners)) {
      try {
        f(this.st);
      } catch {}
    }
  }

  /** The queue, made once per page; it also sends left-overs of earlier pages. */
  queue(): Uploader {
    this.uploader ??= new Uploader({
      store: idbStore(),
      send: (p) => sendPiece(p),
      setTimer: (f, ms) => setTimeout(f, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      onOnline(f) {
        const h = () => {
          window.removeEventListener("online", h);
          f();
        };
        window.addEventListener("online", h);
        return () => window.removeEventListener("online", h);
      },
      onStop: (meeting, status) => {
        if (meeting === this.st.meetingId && this.live())
          void this.stop(status === 413 ? "quota" : "refused");
      },
      onChange: (waiting) => this.set({ waiting }),
    });
    return this.uploader;
  }

  private live() {
    return this.st.phase === "recording" || this.st.phase === "paused";
  }

  /**
   * Start, from a trusted tap only: the meeting row, then the browser's own
   * picker, then the mic, then the recorders.
   */
  async start(o: StartOptions, ev: { isTrusted: boolean }): Promise<StartError | null> {
    if (!ev.isTrusted || this.st.phase === "starting" || this.live()) return "refused";
    const prefs = parseMimePrefs(o.cfg.mimeTypes);
    const has = (t: string) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t);
    const mimeAv = prefs && pickMime(prefs.av, has);
    const mimeAudio = prefs && pickMime(prefs.audio, has);
    if (!mimeAv || !mimeAudio || !navigator.mediaDevices?.getDisplayMedia) return "unsupported";
    // Inside the tap: an AudioContext may start without a further gesture.
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    this.set({ phase: "starting", reason: null, bytes: 0, micLost: false });
    let id: string | null = null;
    try {
      const r = await fetch("/api/my/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tap: true,
          title: defaultTitle(Date.now(), o.titleWord, o.locale),
          mimeAv,
          mimeAudio,
          hasMic: o.mic,
          hasRoomAudio: true,
          device: "desktop",
          transcript: o.transcript,
        }),
      });
      if (!r.ok) {
        void ctx.close();
        this.set({ phase: "idle" });
        return r.status === 429 ? "quota" : "refused";
      }
      id = ((await r.json()) as { id: string }).id;
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: o.cfg.frameRate },
        audio: true,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
      let mic: MediaStream | null = null;
      if (o.mic) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch {
          mic = null;
        }
      }
      this.begin(id, ctx, display, mic, mimeAv, mimeAudio, o);
      return null;
    } catch (e) {
      void ctx.close();
      // The picker cancelled (NotAllowedError) or failed: the empty meeting is removed.
      if (id) void fetch(`/api/my/meetings/${id}`, { method: "DELETE" }).catch(() => {});
      this.set({ phase: "idle", meetingId: null });
      return e instanceof DOMException && e.name === "NotAllowedError" ? "cancelled" : "failed";
    }
  }

  private begin(
    id: string,
    ctx: AudioContext,
    display: MediaStream,
    mic: MediaStream | null,
    mimeAv: string,
    mimeAudio: string,
    o: StartOptions,
  ) {
    this.ctx = ctx;
    this.display = display;
    this.mic = mic;
    this.mime = { av: mimeAv, audio: mimeAudio };
    this.kbps.track = o.cfg.trackKbps;
    this.seq = { av: 0, me: 0, others: 0 };
    this.pending = [];
    this.resamplers = {};
    this.nodes = [];
    this.t0 = performance.now();
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.lastCut = 0;
    const roomTrack = display.getAudioTracks()[0] ?? null;
    const video = display.getVideoTracks()[0];
    this.mixDest = ctx.createMediaStreamDestination();
    const room = roomTrack ? new MediaStream([roomTrack]) : null;
    if (room) this.wire(room, "others");
    if (mic) this.wire(mic, "me");
    const avStream = new MediaStream([video, ...this.mixDest.stream.getAudioTracks()]);
    const av = new MediaRecorder(avStream, {
      mimeType: mimeAv,
      videoBitsPerSecond: o.cfg.videoKbps * 1000,
      audioBitsPerSecond: o.cfg.audioKbps * 1000,
    });
    av.ondataavailable = (e) => this.onAvData(e.data);
    av.onstop = () => void this.finish();
    this.av = av;
    av.start(o.cfg.chunkSec * 1000);
    this.startAudio();
    video.addEventListener("ended", () => void this.stop("share-ended"));
    mic
      ?.getAudioTracks()[0]
      ?.addEventListener("ended", () => this.set({ micLost: true, micOn: false }));
    this.maxTimer = setTimeout(() => void this.stop("max"), o.cfg.maxMinutes * 60_000);
    void import("@lianki/debug-chat/mic-taps")
      .then((m) => {
        if (this.live()) this.releaseMic = m.micTaps().block();
      })
      .catch(() => {});
    addEventListener("beforeunload", this.onUnload);
    this.watchTitle(true);
    this.queue();
    this.set({
      phase: "recording",
      meetingId: id,
      micOn: Boolean(mic),
      roomAudio: Boolean(roomTrack),
    });
  }

  /** One input: into the av mix, and into the PCM hook. */
  private wire(stream: MediaStream, track: AudioTrack) {
    const ctx = this.ctx!;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(this.mixDest!);
    this.nodes.push(src);
    void this.pcmTap(src, track);
  }

  private async pcmTap(src: MediaStreamAudioSourceNode, track: AudioTrack) {
    const ctx = this.ctx;
    if (!ctx?.audioWorklet) return;
    try {
      const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch {
      // Already added in this context (a second input): fine.
    }
    if (this.ctx !== ctx) return;
    const node = new AudioWorkletNode(ctx, "lk-meeting-pcm", { numberOfOutputs: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array[][]>) => {
      if (this.st.phase !== "recording") return;
      let r = this.resamplers[track];
      if (!r) {
        r = new Resampler(ctx.sampleRate, Math.round((this.clock() / 1000) * ctx.sampleRate));
        this.resamplers[track] = r;
      }
      for (const frame of e.data) {
        const out = r.push(toMono(frame));
        if (out.samples.length && this.pcm.size) this.pcm.emit({ track, ...out });
      }
    };
    src.connect(node);
    // Pulled by a destination that is never played (no sound on the speakers).
    node.connect(ctx.createMediaStreamDestination());
    this.nodes.push(node);
  }

  /** A new recorder per piece for me and others, so each piece is a whole file. */
  private startAudio() {
    const streams: [AudioTrack, MediaStream | null][] = [
      ["me", this.mic && this.mic.getAudioTracks()[0]?.readyState === "live" ? this.mic : null],
      [
        "others",
        this.display?.getAudioTracks()[0] ? new MediaStream(this.display.getAudioTracks()) : null,
      ],
    ];
    for (const [track, stream] of streams) {
      if (!stream) continue;
      const rec = new MediaRecorder(stream, {
        mimeType: this.mime.audio,
        audioBitsPerSecond: this.kbps.track * 1000,
      });
      const startMs = this.clock();
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        const seq = this.seq[track]++;
        this.add({
          track,
          seq,
          startMs,
          durMs: this.clock() - startMs,
          fragOff: null,
          fragMs: null,
          blob: e.data,
        });
      };
      rec.start();
      this.audioRec[track] = rec;
    }
  }

  /** Stop the audio recorders (each hands over its whole piece), and start new ones. */
  private cutAudio(restart: boolean): Promise<void> {
    const done: Promise<void>[] = [];
    for (const rec of Object.values(this.audioRec))
      if (rec && rec.state !== "inactive") {
        done.push(
          new Promise<void>((r) => rec.addEventListener("stop", () => r(), { once: true })),
        );
        rec.stop();
      }
    this.audioRec = {};
    if (restart) this.startAudio();
    return Promise.all(done).then(() => {});
  }

  private onAvData(blob: Blob) {
    const now = this.clock();
    const startMs = this.lastCut;
    this.lastCut = now;
    if (blob.size) {
      const seq = this.seq.av++;
      this.add({
        track: "av",
        seq,
        startMs,
        durMs: now - startMs,
        fragOff: null,
        fragMs: null,
        blob,
      });
    }
    this.cutting = this.cutAudio(this.live());
  }

  private add(p: Piece) {
    const id = this.st.meetingId;
    if (!id) return;
    const job = (async () => {
      const bytes = await p.blob.arrayBuffer();
      const u8 = new Uint8Array(bytes);
      let { fragOff, fragMs } = p;
      if (p.track === "av") {
        const off = firstFragment(u8, this.mime.av);
        fragOff = off >= 0 ? off : null;
        fragMs =
          off >= 0
            ? ((/webm/i.test(this.mime.av) ? clusterTimecode(u8, off) : null) ?? p.startMs)
            : null;
      }
      this.set({ bytes: this.st.bytes + bytes.byteLength });
      await this.queue().add({
        meeting: id,
        track: p.track,
        seq: p.seq,
        startMs: p.startMs,
        durMs: p.durMs,
        fragOff,
        fragMs,
        sha256: await sha256Hex(u8),
        bytes,
        at: Date.now(),
      });
    })().catch(() => {});
    this.pending.push(job);
  }

  pause() {
    if (this.st.phase !== "recording") return;
    this.av?.pause();
    for (const r of Object.values(this.audioRec)) r?.pause();
    this.pausedAt = performance.now();
    this.set({ phase: "paused" });
  }

  resume() {
    if (this.st.phase !== "paused" || this.pausedAt === null) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
    this.av?.resume();
    for (const r of Object.values(this.audioRec)) r?.resume();
    this.set({ phase: "recording" });
  }

  /** The mic again after it was lost (a tap). From the next piece on, `me` records again. */
  async resumeMic(): Promise<boolean> {
    if (!this.live() || !this.ctx) return false;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.mic = mic;
      this.resamplers.me = undefined;
      this.wire(mic, "me");
      mic
        .getAudioTracks()[0]
        ?.addEventListener("ended", () => this.set({ micLost: true, micOn: false }));
      this.set({ micLost: false, micOn: true });
      return true;
    } catch {
      return false;
    }
  }

  async stop(reason: StopReason = "user") {
    if (!this.live()) return;
    if (this.pausedAt !== null) this.resume();
    this.set({ phase: "stopping", reason });
    if (this.av && this.av.state !== "inactive") this.av.stop();
    else void this.finish();
  }

  private finishing = false;
  /** The audio recorders being stopped at the last av piece. */
  private cutting: Promise<void> = Promise.resolve();
  private async finish() {
    if (this.finishing) return;
    this.finishing = true;
    try {
      // The last audio pieces arrive before their recorders' "stop" event.
      await Promise.all([this.cutting, this.cutAudio(false)]);
      await Promise.all(this.pending);
      for (const t of [...(this.display?.getTracks() ?? []), ...(this.mic?.getTracks() ?? [])])
        t.stop();
      for (const n of this.nodes) n.disconnect();
      void this.ctx?.close().catch(() => {});
      if (this.maxTimer) clearTimeout(this.maxTimer);
      this.releaseMic?.();
      this.releaseMic = null;
      removeEventListener("beforeunload", this.onUnload);
      this.watchTitle(false);
      const id = this.st.meetingId;
      const reason = this.st.reason;
      this.set({ phase: "ended", micOn: false });
      this.ctx = null;
      this.display = this.mic = null;
      this.av = null;
      this.t0 = 0;
      // The end, once the last piece is up (in the background; a closed tab leaves it to the next visit).
      if (id) {
        const q = this.queue();
        await q.idle();
        await fetch(`/api/my/meetings/${id}/end`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reason === "refused" ? { interrupted: true } : {}),
        }).catch(() => {});
      }
    } finally {
      this.finishing = false;
    }
  }

  private onUnload = (e: BeforeUnloadEvent) => {
    if (!this.live()) return;
    e.preventDefault();
    e.returnValue = "";
  };

  /** The tab title carries "● " while recording; kept through page changes. */
  private watchTitle(on: boolean) {
    const mark = "● ";
    const apply = () => {
      if (!document.title.startsWith(mark)) document.title = mark + document.title;
    };
    this.titleObs?.disconnect();
    this.titleObs = null;
    if (on) {
      apply();
      this.titleObs = new MutationObserver(() => {
        if (this.live()) apply();
      });
      this.titleObs.observe(document.head, { subtree: true, childList: true, characterData: true });
    } else if (document.title.startsWith(mark)) document.title = document.title.slice(mark.length);
  }
}

const KEY = "__lkMeeting";
/** The page's recorder, made once. */
export function meetingRecorder(): MeetingRecorder {
  const g = globalThis as unknown as Record<string, MeetingRecorder | undefined>;
  if (!g[KEY]) {
    g[KEY] = new MeetingRecorder();
    // The floating bar (app/components/MeetingBar.tsx) listens for this, so it never loads the recorder itself.
    if (typeof dispatchEvent === "function") dispatchEvent(new Event("lk-meeting"));
  }
  return g[KEY];
}
export type { MeetingRecorder };

/**
 * Pieces left in IndexedDB by an earlier page (a reload, a crash): sent now,
 * then each of their meetings is marked `interrupted`. No tap needed —
 * nothing new is recorded.
 */
export async function resumeLeftovers(): Promise<number> {
  const rec = meetingRecorder();
  const q = rec.queue();
  const meetings = await q.loadLeftovers(rec.state.meetingId ?? undefined);
  if (!meetings.length) return 0;
  await q.idle();
  for (const id of meetings)
    await fetch(`/api/my/meetings/${id}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interrupted: true }),
    }).catch(() => {});
  return meetings.length;
}
