import { createLocalStt, type LocalStt, type WsLike } from "@lianki/debug-chat/local-stt";
import {
  publicOpen,
  PUBLIC_RTC_URL,
  PUBLIC_CONNECT_TIMEOUT_MS,
  type PublicDeps,
} from "@lianki/debug-chat/public-stt";
import { checkAbort, MeetingTranscriptionError, validateFrame, type Transcribe } from "./contracts";

/** Explicit per-meeting provider choice; never selects a tunnel or cloud fallback. */
export function createMeetingLocalStt(options: {
  route: string;
  maxSamples: number;
  /** Rotate between decoder calls before the shortest speech-session lease. */
  connectionReuseMs?: number;
  now?: () => number;
  publicDeps?: PublicDeps;
  /** Required for an explicitly approved legacy socket; never inferred from mic settings. */
  openApprovedSocket?: (url: string, protocols?: string[]) => WsLike;
  createClient?: (urls: string[]) => Pick<LocalStt, "begin" | "close">;
}): Transcribe & { close(): void } {
  if (!options.route || !Number.isSafeInteger(options.maxSamples) || options.maxSamples < 1)
    throw new MeetingTranscriptionError("config");
  if (
    options.connectionReuseMs !== undefined &&
    (!Number.isFinite(options.connectionReuseMs) ||
      options.connectionReuseMs < 1000 ||
      options.connectionReuseMs > 30000)
  )
    throw new MeetingTranscriptionError("config");
  const lianki = options.route === PUBLIC_RTC_URL;
  const route = (() => {
    if (lianki) return PUBLIC_RTC_URL;
    let url: URL;
    try {
      url = new URL(options.route);
    } catch {
      throw new MeetingTranscriptionError("config");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !options.openApprovedSocket ||
      url.username ||
      url.password ||
      url.hash ||
      !(url.protocol === "wss:" || (loopback && url.protocol === "ws:"))
    )
      throw new MeetingTranscriptionError("config");
    return url.href;
  })();
  const clients = new Map<
    string,
    { client: Pick<LocalStt, "begin" | "close">; busy: boolean; openedAt: number }
  >();
  const now = options.now ?? (() => performance.now());
  const transcribe: Transcribe = async (window, signal) => {
    checkAbort(signal);
    validateFrame(window, options.maxSamples);
    let connection = clients.get(window.track);
    if (connection?.busy) throw new MeetingTranscriptionError("busy");
    if (
      connection &&
      options.connectionReuseMs !== undefined &&
      now() - connection.openedAt >= options.connectionReuseMs
    ) {
      clients.delete(window.track);
      try {
        connection.client.close();
      } catch {
        throw new MeetingTranscriptionError("provider");
      }
      connection = undefined;
    }
    if (!connection) {
      let client: Pick<LocalStt, "begin" | "close">;
      try {
        client =
          options.createClient?.([route]) ??
          createLocalStt([route], {
            open: lianki ? publicOpen(options.publicDeps) : options.openApprovedSocket,
            ...(lianki ? { connectTimeoutMs: PUBLIC_CONNECT_TIMEOUT_MS } : {}),
          });
      } catch {
        throw new MeetingTranscriptionError("provider");
      }
      connection = { client, busy: false, openedAt: now() };
      clients.set(window.track, connection);
    }
    const current = connection,
      client = current.client;
    const disconnect = () => {
      if (clients.get(window.track) === current) clients.delete(window.track);
      client.close();
    };
    current.busy = true;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        disconnect();
        reject(new MeetingTranscriptionError("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      checkAbort(signal);
      const utterance = client.begin(() => {});
      if (!utterance) throw new MeetingTranscriptionError("provider");
      // The existing protocol owns begin, tagged PCM16 frames and end/final correlation.
      for (let offset = 0; offset < window.samples.length; offset += 16_000)
        utterance.frame(window.samples.subarray(offset, offset + 16_000));
      const final = await Promise.race([utterance.end(window.samples), aborted]);
      checkAbort(signal);
      if (typeof final.text !== "string") throw new MeetingTranscriptionError("output");
      // LocalFinal has no word timestamps: report the actual window, never decode-time `ms`.
      return final.text.trim()
        ? [
            {
              startMs: 0,
              endMs: window.samples.length / 16,
              text: final.text.trim(),
              ...(final.lang ? { lang: final.lang } : {}),
            },
          ]
        : [];
    } catch (error) {
      disconnect();
      if (signal.aborted) throw new MeetingTranscriptionError("aborted");
      throw error instanceof MeetingTranscriptionError
        ? error
        : new MeetingTranscriptionError("provider");
    } finally {
      signal.removeEventListener("abort", onAbort);
      current.busy = false;
    }
  };
  return Object.assign(transcribe, {
    close() {
      for (const { client } of clients.values()) client.close();
      clients.clear();
    },
  });
}
