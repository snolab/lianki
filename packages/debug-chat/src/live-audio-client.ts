/** One explicit same-machine duplex connection. No microphone, speaker, auth mint or reconnect. */
import { type LiveTicket, liveFormat, liveFrameBytes } from "./live-audio-core";
export type LiveFrame = {
  sequence: number;
  sampleOffset: number;
  sourceId: string;
  destinationId: string;
  pcm: ArrayBuffer;
};
export type LiveState = "connecting" | "ready" | "input-ended" | "draining" | "closed";
export type LiveSocket = {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
};
export type LiveConnection = {
  ready: Promise<void>;
  write(pcm: ArrayBuffer, signal?: AbortSignal): Promise<void>;
  endInput(): void;
  cancel(): void;
  state(): LiveState;
};
/** Output consumers receive an abort signal; cancellation never waits for an uncooperative sink. */
export function connectLiveAudio(
  ticket: LiveTicket,
  d: {
    socket(url: string): LiveSocket;
    consume(frame: LiveFrame, signal: AbortSignal): Promise<void> | void;
    changed?(state: LiveState): void;
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  },
): LiveConnection {
  const ws = d.socket(ticket.url);
  ws.binaryType = "arraybuffer";
  const abort = new AbortController();
  const later = d.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms)),
    clear =
      d.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let state: LiveState = "connecting",
    credit = 0,
    sent = 0,
    acknowledged = -1;
  let outputSequence = 0,
    outputBytes = 0,
    pumping = false,
    inputEnded = false;
  let descriptor: (Omit<LiveFrame, "pcm"> & { byteLength: number }) | null = null;
  const pending: { pcm: ArrayBuffer; resolve(): void; reject(e: Error): void }[] = [];
  const output: LiveFrame[] = [];
  let resolveReady!: () => void, rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may cancel before it starts awaiting ready.
  void ready.catch(() => {});
  const notify = () => {
    try {
      d.changed?.(state);
    } catch {
      /* Observer cannot control lifetime. */
    }
  };
  let deadline: unknown;
  const close = () => {
    if (state === "closed") return;
    state = "closed";
    clear(deadline);
    abort.abort();
    descriptor = null;
    output.length = 0;
    outputBytes = 0;
    const error = Error("live-audio-closed");
    for (const write of pending.splice(0)) write.reject(error);
    rejectReady(error);
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* Already gone. */
    }
    notify();
  };
  const drain = () => {
    if (state === "closed" || state === "draining") return;
    clear(deadline);
    state = "draining";
    for (const write of pending.splice(0)) write.reject(Error("live-audio-input-ended"));
    deadline = later(close, 2000); // Bounded graceful tail; cancel remains immediate.
    notify();
    if (!pumping && !output.length) close();
  };
  const control = (value: object) => {
    if (state === "closed" || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(value));
      return true;
    } catch {
      close();
      return false;
    }
  };
  const pumpInput = () => {
    while (state === "ready" && pending.length && credit >= ticket.maxFrameBytes) {
      const next = pending.shift()!;
      if (ws.bufferedAmount > ticket.inputWindowBytes) {
        next.reject(Error("live-audio-overflow"));
        close();
        return;
      }
      credit -= ticket.maxFrameBytes;
      sent++;
      try {
        ws.send(next.pcm);
        next.resolve();
      } catch {
        next.reject(Error("live-audio-closed"));
        close();
        return;
      }
    }
  };
  const isClosed = () => state === "closed";
  const pumpOutput = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (state !== "closed" && output.length) {
        const frame = output.shift()!;
        await d.consume(frame, abort.signal);
        if (isClosed()) return;
        outputBytes -= frame.pcm.byteLength;
        if (state !== "draining" && !control({ type: "output-ack", sequence: frame.sequence }))
          return;
      }
    } catch {
      close();
    } finally {
      pumping = false;
      if (state === "draining") close();
    }
  };
  // Browser permission prompts happen before open; allow only the ticket's remaining lifetime.
  deadline = later(close, Math.max(0, ticket.expiresAt - Date.now()));
  ws.onopen = () => {
    if (state !== "connecting") return;
    if (Date.now() >= ticket.expiresAt) return close();
    clear(deadline);
    deadline = later(close, 2000); // Wire v1 hello/ready deadline starts after the WS opens.
    control({
      type: "hello",
      version: 1,
      capability: ticket.capability,
      sourceId: ticket.sourceId,
      destinationId: ticket.destinationId,
      input: ticket.input,
      output: ticket.output,
      frameMs: 20,
    });
  };
  ws.onerror = close;
  ws.onclose = () => {
    if (state !== "draining") close();
  };
  ws.onmessage = ({ data }) => {
    if (state === "closed" || state === "draining") return;
    try {
      if (data instanceof ArrayBuffer) {
        if (
          !descriptor ||
          data.byteLength !== ticket.maxFrameBytes ||
          data.byteLength !== descriptor.byteLength
        )
          return close();
        outputBytes += data.byteLength;
        if (outputBytes > ticket.inputWindowBytes) return close();
        output.push({ ...descriptor, pcm: data });
        descriptor = null;
        void pumpOutput();
        return;
      }
      if (typeof data !== "string") return close();
      const msg = JSON.parse(data);
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return close();
      if (msg.type === "closed") {
        if (
          !descriptor &&
          (state === "ready" || state === "input-ended") &&
          ["duration-limit", "renderer-ended"].includes(msg.reason)
        )
          return drain();
        return close();
      }
      if (descriptor) return close(); // Its binary must be the very next message.
      if (msg.type === "ready") {
        if (
          state !== "connecting" ||
          msg.version !== 1 ||
          msg.sourceId !== ticket.sourceId ||
          msg.destinationId !== ticket.destinationId ||
          msg.frameMs !== 20 ||
          msg.maxFrameBytes !== ticket.maxFrameBytes ||
          msg.inputWindowBytes !== ticket.inputWindowBytes ||
          msg.outputWindowBytes !== ticket.inputWindowBytes ||
          JSON.stringify(liveFormat(msg.input)) !== JSON.stringify(ticket.input) ||
          JSON.stringify(liveFormat(msg.output)) !== JSON.stringify(ticket.output)
        )
          return close();
        clear(deadline);
        state = "ready";
        credit = ticket.inputWindowBytes;
        resolveReady();
        notify();
      } else if (msg.type === "credit") {
        if (
          (state !== "ready" && state !== "input-ended") ||
          msg.bytes !== ticket.maxFrameBytes ||
          msg.inputSequence !== acknowledged + 1 ||
          msg.inputSequence >= sent ||
          credit + msg.bytes > ticket.inputWindowBytes
        )
          return close();
        acknowledged = msg.inputSequence;
        credit += msg.bytes;
        pumpInput();
      } else if (msg.type === "frame") {
        if (
          (state !== "ready" && state !== "input-ended") ||
          msg.sequence !== outputSequence ||
          msg.sampleOffset !== (outputSequence * ticket.output.sampleRate) / 50 ||
          msg.byteLength !== liveFrameBytes(ticket.output) ||
          msg.sourceId !== ticket.destinationId ||
          msg.destinationId !== ticket.sourceId
        )
          return close();
        descriptor = {
          sequence: outputSequence++,
          sampleOffset: msg.sampleOffset,
          byteLength: msg.byteLength,
          sourceId: msg.sourceId,
          destinationId: msg.destinationId,
        };
      } else if (msg.type === "input-ended") {
        if (!inputEnded || state !== "input-ended") return close();
      } else close();
    } catch {
      close();
    }
  };
  return {
    ready,
    write(pcm, signal) {
      if (signal?.aborted) return Promise.reject(Error("live-audio-route-changed"));
      if (
        state !== "ready" ||
        inputEnded ||
        !(pcm instanceof ArrayBuffer) ||
        pcm.byteLength !== ticket.maxFrameBytes
      )
        return Promise.reject(Error("live-audio-invalid-frame"));
      if ((pending.length + 1) * pcm.byteLength > ticket.inputWindowBytes) {
        close();
        return Promise.reject(Error("live-audio-overflow"));
      }
      const promise = new Promise<void>((resolve, reject) => {
        const cancel = () => {
          const at = pending.indexOf(entry);
          if (at >= 0) {
            pending.splice(at, 1);
            entry.reject(Error("live-audio-route-changed"));
          }
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const entry = {
          pcm: pcm.slice(0),
          resolve() {
            cleanup();
            resolve();
          },
          reject(e: Error) {
            cleanup();
            reject(e);
          },
        };
        pending.push(entry);
        signal?.addEventListener("abort", cancel, { once: true });
      });
      pumpInput();
      return promise;
    },
    endInput() {
      if (state !== "ready" || inputEnded || pending.length)
        throw Error("live-audio-input-pending");
      inputEnded = true;
      state = "input-ended";
      control({ type: "end-input" });
      notify();
    },
    cancel() {
      if (state === "closed") return;
      control({ type: "cancel" });
      close();
    },
    state: () => state,
  };
}
