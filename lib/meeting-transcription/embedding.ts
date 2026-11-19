"use client";

import {
  createVoiceprintWorkerClient,
  validateOptions,
  type ExtractorOptions,
  type VoiceprintWorkerClient,
} from "../../vendor/otoji/packages/voiceprint-web/src/index";
import { checkAbort, validateFrame, type Embed } from "./contracts";

export const MEETING_VOICE_MODEL_BYTES = 28_281_164;
export const MEETING_VOICE_MODEL_SHA256 =
  "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2";

export interface MeetingEmbeddingManifest extends ExtractorOptions {
  workerUrl: string;
}
export type MeetingEmbeddingStatus =
  | "consent-required"
  | "assets-unavailable"
  | "embedding-unavailable"
  | "audio-invalid"
  | "busy"
  | "ready"
  | "aborted"
  | "closed";
export interface MeetingEmbeddingOptions {
  consent: boolean;
  manifest?: MeetingEmbeddingManifest | null;
  /** Pin to the consuming page's own location.origin, never a provider/CDN origin. */
  origin: string;
  onStatus?: (status: MeetingEmbeddingStatus) => void;
}
export interface MeetingEmbeddingProvider {
  embed: Embed;
  /** Retire this run. A later explicit embedding call starts a fresh run/worker. */
  close(): void;
}

function ownUrl(raw: string, origin: string): URL {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  )
    throw new Error("assets");
  return url;
}

/** Validate only; this function never fetches assets or creates a worker. */
export function validateMeetingEmbeddingManifest(
  manifest: MeetingEmbeddingManifest,
  origin: string,
): MeetingEmbeddingManifest {
  const base = new URL(origin);
  if (
    base.origin !== origin ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("Meeting embedding assets unavailable.");
  const options = validateOptions(manifest);
  ownUrl(options.model.url, origin);
  ownUrl(options.wasmBaseUrl, origin);
  const worker = ownUrl(manifest.workerUrl, origin);
  if (
    options.model.bytes !== MEETING_VOICE_MODEL_BYTES ||
    options.model.sha256 !== MEETING_VOICE_MODEL_SHA256 ||
    options.model.precision !== "fp32"
  )
    throw new Error("Meeting embedding assets unavailable.");
  return { ...options, model: { ...options.model }, workerUrl: worker.href };
}

interface Generation {
  client: VoiceprintWorkerClient | null;
  warm: boolean;
  failed: boolean;
  busy: boolean;
  retired: boolean;
}

/**
 * Device-only advisory embeddings, with no remote fallback or account matching.
 * The application must supply approved local static assets: no model API exists yet.
 * Constructing this provider is inert. Explicit consent plus the first valid call
 * creates one dedicated worker; failures stay sticky until an explicit close/run reset.
 */
export function createMeetingEmbedding(
  options: MeetingEmbeddingOptions,
  deps: { createWorker?: (url: string) => Worker } = {},
): MeetingEmbeddingProvider {
  let manifest: MeetingEmbeddingManifest | null = null;
  try {
    if (options.manifest)
      manifest = validateMeetingEmbeddingManifest(options.manifest, options.origin);
  } catch {
    /* Missing or invalid assets are advisory unknown, never a remote fallback. */
  }
  const consent = options.consent === true;
  let current: Generation | null = null;
  let lastStatus: MeetingEmbeddingStatus | null = null;
  const notify = (status: MeetingEmbeddingStatus) => {
    if (status === lastStatus) return;
    lastStatus = status;
    try {
      options.onStatus?.(status);
    } catch {
      /* Status callbacks cannot turn advisory metadata into a transcription failure. */
    }
  };
  const active = (run: Generation) => current === run && !run.retired;
  const retire = (run: Generation) => {
    run.retired = true;
    run.client?.dispose();
    run.client = null;
    run.warm = false;
  };

  return {
    async embed(window, signal) {
      if (!consent) {
        notify("consent-required");
        return null;
      }
      if (!manifest) {
        notify("assets-unavailable");
        return null;
      }
      try {
        checkAbort(signal);
      } catch {
        notify("aborted");
        return null;
      }
      try {
        validateFrame(window, 30 * 16000);
        if (window.samples.length < (manifest.minAudioMs ?? 1200) * 16) throw new Error("audio");
      } catch {
        notify("audio-invalid");
        return null;
      }
      const run = (current ??= {
        client: null,
        warm: false,
        failed: false,
        busy: false,
        retired: false,
      });
      if (run.failed || run.retired) return null;
      if (run.busy) {
        notify("busy");
        return null;
      }
      run.busy = true;
      const abort = () => {
        if (!active(run)) return;
        retire(run);
        notify("aborted");
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!run.client) {
          const worker = (
            deps.createWorker ??
            ((url) => new Worker(url, { type: "module", name: "meeting-voice" }))
          )(manifest.workerUrl);
          if (!active(run) || signal.aborted) {
            worker.terminate();
            return null;
          }
          try {
            run.client = createVoiceprintWorkerClient(worker);
          } catch {
            worker.terminate();
            throw new Error("worker");
          }
        }
        if (!run.warm) {
          await run.client.warm(
            {
              model: { ...manifest.model },
              wasmBaseUrl: manifest.wasmBaseUrl,
              minAudioMs: manifest.minAudioMs,
            },
            true,
          );
          if (!active(run) || signal.aborted) return null;
          run.warm = true;
        }
        const result = await run.client.extract(window.samples, signal);
        if (!active(run) || signal.aborted) return null;
        if (result.model !== manifest.model.id) throw new Error("artifact");
        notify("ready");
        return active(run) && !signal.aborted ? result.embedding : null;
      } catch {
        if (active(run)) {
          run.failed = true;
          notify(run.warm ? "embedding-unavailable" : "assets-unavailable");
          run.client?.dispose();
          run.client = null;
        }
        return null;
      } finally {
        signal.removeEventListener("abort", abort);
        run.busy = false;
      }
    },
    close() {
      const run = current;
      current = null;
      if (run) {
        retire(run);
        notify("closed");
      }
    },
  };
}
