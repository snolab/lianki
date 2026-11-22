"use client";
import { SealSwitch } from "@/app/components/SealSwitch";
import { useEffect, useRef, useState } from "react";
import {
  connectLiveAudio,
  type LiveConnection,
  type LiveSocket,
  type LiveState,
} from "@lianki/debug-chat/live-audio-client";
import {
  decodeLivePcm,
  encodeLivePcm,
  liveFrameSamples,
  liveAliases,
  liveTicket,
  mixLiveFrame,
  type LiveTicket,
  type LiveSourceFrame,
} from "@lianki/debug-chat/live-audio-core";

import { liveMic, liveMicFrames } from "@lianki/debug-chat/live-mic";
import { browserLiveMonitor } from "@lianki/debug-chat/live-monitor";
import { pageAudio } from "@lianki/debug-chat/page-audio";

type Settings = {
  toneHz: number;
  peak: number;
  gain: number;
  maxGain: number;
  uiRefreshMs: number;
};
const ZERO = { inputFrames: 0, outputFrames: 0, clipped: 0 };
/** Explicit route; device endpoints remain independently opt-in. */
export default function LiveAudioPanel({
  labels: t,
  settings,
}: {
  labels: Record<string, string>;
  settings: Settings;
}) {
  const [ticket, setTicket] = useState<LiveTicket | null>(null),
    [route, setRoute] = useState({ source: "", target: "" });
  const [state, setState] = useState<LiveState>("closed"),
    [error, setError] = useState(false),
    [stats, setStats] = useState(ZERO);
  const [controls, setControls] = useState({
    mic: false,
    a: true,
    b: false,
    aGain: settings.gain,
    bGain: settings.gain,
  });
  const [micOn, setMicOn] = useState(false),
    [monitorOn, setMonitorOn] = useState(false);
  const micFrames = useRef(liveMicFrames());
  const removeMic = useRef<(() => void) | null>(null);
  const monitor = useRef<ReturnType<typeof browserLiveMonitor> | null>(null);
  const frameAbort = useRef<AbortController | null>(null);
  const control = useRef(controls);
  control.current = controls;
  const connection = useRef<LiveConnection | null>(null),
    generation = useRef(0);
  const inputTimer = useRef<ReturnType<typeof setInterval> | null>(null),
    statsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const totals = useRef({ ...ZERO }),
    endRequested = useRef(false);
  const clearInput = () => {
    if (inputTimer.current !== null) clearInterval(inputTimer.current);
    inputTimer.current = null;
  };
  const clearStats = () => {
    if (statsTimer.current !== null) clearInterval(statsTimer.current);
    statsTimer.current = null;
  };
  const dispose = () => {
    generation.current++;
    removeMic.current?.();
    removeMic.current = null;
    micFrames.current.clear();
    monitor.current?.dispose();
    monitor.current = null;
    frameAbort.current?.abort();
    clearInput();
    clearStats();
    connection.current?.cancel();
    connection.current = null;
  };
  const stop = () => {
    dispose();
    setState("closed");
    setMonitorOn(false);
    setStats({ ...totals.current });
  };
  useEffect(() => {
    const syncMic = () => {
      const on = pageAudio().mic();
      setMicOn(on);
      if (!on) micFrames.current.clear();
    };
    syncMic();
    const unwatch = pageAudio().subscribe(syncMic);
    const leave = () => {
      dispose();
      setMonitorOn(false);
      setState("closed");
    };
    window.addEventListener("pagehide", leave);
    return () => {
      unwatch();
      window.removeEventListener("pagehide", leave);
      dispose();
    };
  }, []);
  const change = (patch: Partial<typeof controls>) => {
    const next = { ...control.current, ...patch };
    control.current = next;
    setControls(next);
    frameAbort.current?.abort();
    if (patch.mic !== undefined) micFrames.current.clear();
  };
  const toggleMonitor = (on: boolean) => {
    monitor.current?.dispose();
    monitor.current = null;
    try {
      if (on) monitor.current = browserLiveMonitor();
      setMonitorOn(on);
    } catch {
      setMonitorOn(false);
      setError(true);
    }
  };
  const busy = state !== "closed";
  const importTicket = async (file: File | undefined) => {
    if (!file) return;
    const mine = ++generation.current;
    try {
      if (file.size > 16384) throw Error("invalid-ticket"); // bounded control file, never PCM
      const parsed = liveTicket(JSON.parse(await file.text()), location.origin);
      if (mine !== generation.current) return;
      setTicket(parsed);
      setRoute({ source: parsed.sourceId, target: parsed.destinationId });
      setError(false);
    } catch {
      if (mine === generation.current) {
        setTicket(null);
        setError(true);
      }
    }
  };
  const start = async () => {
    if (!ticket || connection.current) return;
    const mine = ++generation.current;
    let current: LiveConnection;
    try {
      const opened = liveTicket(ticket, location.origin);
      setTicket(null);
      setError(false);
      setState("connecting");
      endRequested.current = false;
      totals.current = { ...ZERO };
      setStats({ ...ZERO });
      const aliases = liveAliases(opened);
      let micId = "li-mic";
      const reserved = new Set([opened.sourceId, opened.destinationId, ...Object.values(aliases)]);
      while (reserved.has(micId)) micId += "_";
      micFrames.current.clear();
      removeMic.current = liveMic().subscribe((frame) => {
        const allowed = control.current.mic && pageAudio().mic();
        micFrames.current.push(allowed ? frame : null);
        // Off/hold/privacy can pause VAD before another tick. Retract unsent
        // mixed audio too; the other sources continue on the next fresh tick.
        if (control.current.mic && (!allowed || frame === null)) frameAbort.current?.abort();
      });
      let returned: LiveSourceFrame | null = null,
        frameIndex = 0,
        writing = false;
      current = connectLiveAudio(opened, {
        socket: (url) => new WebSocket(url) as unknown as LiveSocket,
        consume(frame, signal) {
          if (signal.aborted || mine !== generation.current) return;
          returned = {
            id: aliases.returned,
            origin: opened.destinationId,
            format: opened.output,
            samples: decodeLivePcm(frame.pcm),
          };
          totals.current.outputFrames++;
          return monitor.current?.consume(frame.pcm, opened.output, signal).catch((cause) => {
            if (mine === generation.current && !signal.aborted) setError(true);
            throw cause;
          });
        },
        changed(next) {
          if (mine !== generation.current) return;
          setState(next);
          if (next === "draining" || next === "closed") clearInput();
          if (next === "closed") {
            clearStats();
            removeMic.current?.();
            removeMic.current = null;
            micFrames.current.clear();
            monitor.current?.dispose();
            monitor.current = null;
            setMonitorOn(false);
            connection.current = null;
            setStats({ ...totals.current });
          }
        },
      });
      connection.current = current;
      statsTimer.current = setInterval(() => setStats({ ...totals.current }), settings.uiRefreshMs);
      await current.ready;
      if (mine !== generation.current || current.state() !== "ready") {
        current.cancel();
        return;
      }
      const finishInput = () => {
        if (current.state() === "ready") current.endInput();
      };
      const tick = async () => {
        if (writing || current.state() !== "ready" || mine !== generation.current) return;
        if (endRequested.current) {
          clearInput();
          finishInput();
          return;
        }
        writing = true;
        const writeAbort = new AbortController();
        frameAbort.current = writeAbort;
        try {
          const c = control.current;
          const source = (
            id: string,
            rate: 16000 | 48000,
            channels: 1 | 2,
            hz: number,
          ): LiveSourceFrame => {
            const format = { sampleRate: rate, channels, format: "s16le" as const },
              n = liveFrameSamples(format);
            const samples = new Float32Array(n * channels);
            for (let i = 0; i < n; i++) {
              const value =
                Math.sin((2 * Math.PI * hz * (frameIndex * n + i)) / rate) * settings.peak;
              for (let ch = 0; ch < channels; ch++) samples[i * channels + ch] = value;
            }
            return { id, origin: opened.sourceId, format, samples };
          };
          const sources = [
            source(aliases.a, 16000, 1, settings.toneHz),
            source(aliases.b, 48000, 2, settings.toneHz * 2),
          ];
          if (c.mic)
            sources.push({
              id: micId,
              origin: opened.sourceId,
              format: { sampleRate: 16000, channels: 1, format: "s16le" },
              samples: pageAudio().mic() ? micFrames.current.take() : new Float32Array(320),
            });
          if (returned) sources.push(returned);
          const routes = [
            ...(c.mic
              ? [{ sourceId: micId, destinationId: opened.destinationId, gain: settings.gain }]
              : []),
            ...(c.a
              ? [{ sourceId: aliases.a, destinationId: opened.destinationId, gain: c.aGain }]
              : []),
            ...(c.b
              ? [{ sourceId: aliases.b, destinationId: opened.destinationId, gain: c.bGain }]
              : []),
            { sourceId: aliases.returned, destinationId: opened.destinationId, gain: 1 },
          ];
          const mixed = mixLiveFrame(
            opened.destinationId,
            opened.input,
            routes,
            sources,
            settings.maxGain,
          );
          totals.current.clipped += mixed.clipped;
          frameIndex++;
          await current.write(encodeLivePcm(mixed.samples), writeAbort.signal);
          if (mine === generation.current) totals.current.inputFrames++;
        } catch {
          if (
            !writeAbort.signal.aborted &&
            mine === generation.current &&
            current.state() !== "draining" &&
            current.state() !== "closed"
          ) {
            setError(true);
            current.cancel();
          }
        } finally {
          writing = false;
          if (endRequested.current && current.state() === "ready") finishInput();
        }
      };
      inputTimer.current = setInterval(() => void tick(), opened.frameMs);
      void tick();
    } catch {
      if (mine === generation.current) {
        dispose();
        setState("closed");
        setError(true);
      }
    }
  };
  return (
    <section data-testid="live-audio-panel" className="space-y-4">
      <p>{t.intro}</p>
      <label className="block">
        {t.ticket}
        <input
          data-testid="live-ticket"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => {
            void importTicket(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <dl>
        <dt>{t.source}</dt>
        <dd data-testid="live-source">{route.source}</dd>
        <dt>{t.target}</dt>
        <dd data-testid="live-target">{route.target}</dd>
      </dl>
      <label className="block">
        <SealSwitch
          aria-label={t.micSource}
          data-testid="live-route-mic"
          checked={controls.mic}
          disabled={!micOn && !controls.mic}
          onClick={() =>
            change({ mic: !controls.mic, ...(!controls.mic ? { a: false, b: false } : {}) })
          }
        />
        {t.micSource} {!micOn && <span>{t.micOff}</span>}
      </label>
      <label className="block">
        <SealSwitch
          aria-label={t.monitor}
          data-testid="live-monitor"
          checked={monitorOn}
          disabled={state !== "ready" && state !== "input-ended"}
          onClick={() => toggleMonitor(!monitorOn)}
        />
        {t.monitor}
      </label>
      {(["a", "b"] as const).map((key) => (
        <fieldset key={key} className="flex flex-wrap items-center gap-3">
          <label>
            <SealSwitch
              aria-label={key === "a" ? t.sourceA : t.sourceB}
              data-testid={`live-route-${key}`}
              checked={controls[key]}
              onClick={() => change({ [key]: !controls[key] })}
            />
            {key === "a" ? t.sourceA : t.sourceB}
          </label>
          <label>
            {t.gain}
            <input
              data-testid={`live-gain-${key}`}
              type="range"
              min={0}
              max={settings.maxGain * 100}
              value={controls[key === "a" ? "aGain" : "bGain"] * 100}
              onChange={(e) =>
                change({ [key === "a" ? "aGain" : "bGain"]: Number(e.target.value) / 100 })
              }
            />
          </label>
        </fieldset>
      ))}
      <div className="flex gap-3">
        <button data-testid="live-start" disabled={!ticket || busy} onClick={() => void start()}>
          {t.start}
        </button>
        <button data-testid="live-stop" disabled={!busy} onClick={stop}>
          {t.stop}
        </button>
        <button
          data-testid="live-end-input"
          disabled={state !== "ready"}
          onClick={() => {
            endRequested.current = true;
          }}
        >
          {t.endInput}
        </button>
      </div>
      <p>
        {t.state}:{" "}
        <span data-testid="live-state">{t[state === "input-ended" ? "inputEnded" : state]}</span>
      </p>
      <dl>
        {Object.entries(stats).map(([key, value]) => (
          <div key={key}>
            <dt>{t[key]}</dt>
            <dd data-testid={`live-${key}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {error && <p role="alert">{t.error}</p>}
    </section>
  );
}
