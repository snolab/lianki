"use client";

/**
 * The voiceprint panel over the chat bar (voiceprint.ts; docs/local-stt.md,
 * "Voiceprint"): what is enrolled, "Enrol this device" (a consent card
 * first, nothing recorded until its tap), the sentences to read, and "Delete
 * my voiceprint" (confirmed). Owner pages with a local STT only.
 *
 * Inline styles, as in AskCard.tsx: the hot-loaded widget runs on the app's
 * compiled CSS, which has only the classes the app itself was built with.
 */
import { useEffect, useRef, useState } from "react";
import { createLocalStt } from "./local-stt";
import {
  endVoiceprintWindow,
  subscribeVoiceprintWindow,
  voiceprintTicket,
  voiceprintWindow,
} from "./webauthn";
import {
  DEFAULT_BANDS,
  ENROL_MAX,
  ENROL_MIN,
  ENROL_SENTENCES,
  type CloudDeps,
  type CloudInfo,
  type CloudOp,
  type StoredRecording,
  type EnrolDeps,
  type EnrolView,
  type FilterInfo,
  bandFor,
  createEnrolment,
  enrolBusy,
  filterFlag,
  filterPaused,
  readTally,
} from "./voiceprint";
import { notifyDirty, registerDirtyCheck } from "@lianki/ui-state/dirty";
import type { ChatStrings } from "./wire";

const line = (pct: number) => `color-mix(in oklch, currentColor ${pct}%, transparent)`;
const pill = {
  borderRadius: 9999,
  borderWidth: 1,
  borderStyle: "solid",
  padding: "6px 12px",
  fontSize: "calc(12px * var(--lk-fs-k, 1))",
  lineHeight: 1.25,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
} as const;
/** The delete button and its confirmation: a warm red, never the main action's weight. */
const DANGER = "oklch(0.58 0.2 27)";
/** The test's decisions: a mark and a hue each, never colour alone (the label says it too). */
const DECISION_HUE = { me: "oklch(0.56 0.15 150)", other: "oklch(0.58 0.14 60)", unknown: "inherit" } as const;
const DECISION_MARK = { me: "✓", other: "✕", unknown: "?" } as const;
/** The "only my voice" switch (docs/local-stt.md, "Only my voice: the filter"). */
export const FILTER_FLAG_URL = "https://lianki.com/dev/flags#stt.voiceprint-filter";

/**
 * The panel's page side, made when it opens: its own socket to the Mac for
 * the voiceprint requests (never one reachable from globalThis, unlike the
 * mic session), and tickets from lianki.com (webauthn.ts).
 */
export function panelDeps(o: {
  url: string;
  device: string;
  capture: EnrolDeps["capture"];
  testCapture?: EnrolDeps["testCapture"];
  log?: (ev: Record<string, unknown>) => void;
}): EnrolDeps & { close(): void } {
  const c = createLocalStt(o.url, { device: o.device, log: o.log });
  return {
    device: o.device,
    request: (m, ro) => c.request(m, ro),
    // A recording fed to an enrolment (re-compute): the whole clip as one utterance.
    utter: (audio, enrolment) => {
      const u = c.begin(() => {}, { enrol: enrolment });
      if (!u) return Promise.reject(new Error("local stt not connected"));
      return u.end(audio);
    },
    // client: the passkey window is bound to this device (webauthn.ts).
    ticket: (op, device, t) => voiceprintTicket(op, device, { keepAudio: t?.keepAudio, client: o.device }),
    capture: o.capture,
    ...(o.testCapture ? { testCapture: o.testCapture } : {}),
    filterInfo: async (state) => ({ flag: await filterFlag(), paused: filterPaused(), state, tally: readTally() }),
    cloud: cloudDeps(),
    log: o.log,
    close: () => c.close(),
  };
}

export const VOICEPRINT_CLOUD_PATH = "/api/my/voiceprint";
/** His file store (lib/import/files.ts): recordings go to source `voiceprint`. */
const RECORDINGS_PATH = "/api/import/files";
const MY_FILES_PATH = "/api/my/files";
/**
 * The account copy over app/api/my/voiceprint (the session cookie; own rows
 * only). A 404 means the feature is off for this account: no account rows,
 * no buttons.
 */
export function cloudDeps(f: (u: string, i: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): CloudDeps {
  const call = async (method: string, query = "", body?: object) => {
    const r = await f(VOICEPRINT_CLOUD_PATH + query, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, ok: r.ok, j };
  };
  const must = (o: { ok: boolean; status: number; j: Record<string, unknown> }) => {
    if (!o.ok) throw new Error(typeof o.j.error === "string" ? o.j.error : `HTTP ${o.status}`);
    return o.j;
  };
  return {
    async list() {
      const o = await call("GET");
      if (o.status === 404) return null;
      const prints = Array.isArray(must(o).prints) ? (o.j.prints as CloudInfo["prints"]) : [];
      const recordings = await this.recordings.list().then(
        (l) => l.length,
        () => 0,
      );
      return {
        prints,
        recordings,
        ...(typeof o.j.extractor === "string" ? { extractor: o.j.extractor } : {}),
      };
    },
    recordings: {
      async list() {
        const r = await f(`${RECORDINGS_PATH}?source=voiceprint`, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { items?: StoredRecording[] };
        return (j.items ?? []).map((i) => ({ id: i.id, name: i.name }));
      },
      async upload(name, bytes) {
        const r = await f(`${RECORDINGS_PATH}?source=voiceprint`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "audio/wav", "x-file-name": encodeURIComponent(name) },
          body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(`upload ${j.error ?? r.status}`);
        }
      },
      async download(id) {
        const r = await f(`${MY_FILES_PATH}/${encodeURIComponent(id)}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      },
      async delete(id) {
        const r = await f(`${MY_FILES_PATH}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      },
    },
    async features() {
      const j = must(await call("GET", "?features=1"));
      return Array.isArray(j.prints) ? (j.prints as Record<string, unknown>[]) : [];
    },
    async put(ticket, prints) {
      const j = must(await call("PUT", "", { ticket, prints }));
      return typeof j.saved === "number" ? j.saved : prints.length;
    },
    async delete(ticket, device) {
      const j = must(await call("DELETE", "", { ticket, device }));
      return typeof j.deleted === "number" ? j.deleted : 0;
    },
  };
}


export function VoiceprintPanel({
  t,
  deps: make,
  onClose,
}: {
  t: ChatStrings;
  /** Made once per open panel; `close` (if any) when it unmounts. */
  deps: () => EnrolDeps & { close?(): void };
  onClose: () => void;
}) {
  const [view, setViewState] = useState<EnrolView>({ step: "closed" });
  // Read by the page's dirty check at once, not after the next render.
  const viewNow = useRef<EnrolView>(view);
  const setView = (v: EnrolView) => {
    viewNow.current = v;
    setViewState(v);
    notifyDirty();
  };
  // An enrolment under way holds the deploy auto-reload and the leave guard (lib/page-dirty.ts).
  useEffect(() => registerDirtyCheck(() => enrolBusy(viewNow.current)), []);
  const ctl = useRef<{ c: ReturnType<typeof createEnrolment>; d: EnrolDeps & { close?(): void } } | null>(
    null,
  );
  if (!ctl.current) {
    const d = make();
    ctl.current = { c: createEnrolment(d, setView), d };
  }
  const { c, d } = ctl.current;
  // The passkey window (webauthn.ts): shown while open, gone when it ends (one timer to its end, no polling).
  const [, setTick] = useState(0);
  const windowUntil = voiceprintWindow();
  useEffect(() => subscribeVoiceprintWindow(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    if (!windowUntil) return;
    const h = setTimeout(() => setTick((n) => n + 1), Math.max(0, windowUntil - Date.now()) + 50);
    return () => clearTimeout(h);
  }, [windowUntil]);
  useEffect(() => {
    void c.open();
    // Closing the panel drops an enrolment under way (unsaved) and gives the mic back.
    return () => {
      c.close();
      // The cancel goes out first; then the panel's socket closes.
      setTimeout(() => d.close?.(), 500);
    };
  }, [c, d]);
  const close = () => {
    c.close();
    onClose();
  };
  const btn = (
    testid: string,
    label: string,
    onClick: () => void,
    o: { primary?: boolean; danger?: boolean; disabled?: boolean; trusted?: boolean } = {},
  ) => (
    <button
      type="button"
      data-testid={testid}
      disabled={o.disabled}
      onMouseDown={(e) => e.preventDefault()}
      // Enrol and delete: a real tap only (defence in depth; the passkey is the real gate).
      onClick={(e) => (o.trusted && !e.nativeEvent.isTrusted ? undefined : onClick())}
      className="tap-40 pointer-events-auto"
      style={{
        ...pill,
        borderColor: o.danger ? DANGER : line(o.primary ? 100 : 35),
        color: o.danger ? DANGER : "inherit",
        fontWeight: o.primary ? 600 : 400,
        opacity: o.disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
  const row = (children: React.ReactNode) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{children}</div>
  );
  const note = (text: string, testid?: string) => (
    <p data-testid={testid} style={{ margin: "6px 0 0", fontSize: "calc(12px * var(--lk-fs-k, 1))", opacity: 0.75 }}>
      {text}
    </p>
  );
  const again: Record<string, string> = {
    short: t.vpShort,
    noise: t.vpNoise,
    mismatch: t.vpMismatch,
    text: t.vpText,
    unreachable: t.vpUnreachable,
  };

  /** "Only my voice": what it does right now, today's counts, and this device's pause. */
  const filterBlock = (f: FilterInfo) => {
    const active = f.flag && !f.paused && f.state === "on";
    return (
      <div data-testid="debug-voiceprint-filter" data-state={active ? "on" : f.state} style={{ marginTop: 10 }}>
        {note(!f.flag || f.paused ? t.vpFilterOff : active ? t.vpFilterOn : t.vpFilterWaiting)}
        {f.tally.n > 0 &&
          note(
            t.vpFilterCount
              .replaceAll("{n}", String(f.tally.n))
              .replaceAll("{score}", f.tally.score === undefined ? "–" : f.tally.score.toFixed(2)),
            "debug-voiceprint-filter-count",
          )}
        {f.tally.would > 0 &&
          note(t.vpFilterWould.replaceAll("{n}", String(f.tally.would)), "debug-voiceprint-filter-would")}
        {f.flag && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: "calc(12px * var(--lk-fs-k, 1))" }} className="pointer-events-auto">
            <input
              type="checkbox"
              data-testid="debug-voiceprint-filter-pause"
              checked={f.paused}
              onChange={(e) => c.pauseFilter(e.currentTarget.checked)}
            />
            {t.vpFilterPause}
          </label>
        )}
      </div>
    );
  };

  /** The copy in his account: what is there, the last save/restore, and the two taps. */
  const cloudBlock = (cl: CloudInfo, op: CloudOp | undefined, local: boolean, restore: boolean) => {
    const devices = [...new Set(cl.prints.map((p) => p.device))].join(", ");
    const busy = op?.state === "busy";
    return (
      <div data-testid="debug-voiceprint-cloud" data-state={op ? `${op.kind}-${op.state}` : "idle"} style={{ marginTop: 10 }}>
        {note(cl.prints.length ? t.vpCloudHas.replaceAll("{devices}", devices) : t.vpCloudNone, "debug-voiceprint-cloud-list")}
        {(cl.recordings ?? 0) > 0 &&
          note(t.vpRecHas.replaceAll("{n}", String(cl.recordings)), "debug-voiceprint-recordings")}
        {op?.state === "busy" &&
          note(op.kind === "save" ? t.vpCloudSaving : op.kind === "restore" ? t.vpCloudRestoring : t.vpRecomputing)}
        {op?.state === "done" &&
          note(
            (op.kind === "save" ? t.vpCloudSaved : op.kind === "restore" ? t.vpCloudRestored : t.vpRecomputed).replaceAll(
              "{n}",
              String(op.n),
            ),
            "debug-voiceprint-cloud-done",
          )}
        {op?.state === "done" &&
          (op.files ?? 0) > 0 &&
          note(t.vpRecSaved.replaceAll("{n}", String(op.files)), "debug-voiceprint-recordings-saved")}
        {op?.state === "failed" && note(t.vpCloudFailed.replaceAll("{error}", op.error), "debug-voiceprint-cloud-error")}
        {local &&
          row(
            <>
              {btn("debug-voiceprint-cloud-save", t.vpCloudSave, () => c.saveToAccount(), { trusted: true, disabled: busy })}
              {restore &&
                cl.prints.length > 0 &&
                btn("debug-voiceprint-cloud-restore", t.vpCloudRestore, () => c.restoreFromAccount(), {
                  trusted: true,
                  disabled: busy,
                })}
              {restore &&
                (cl.recordings ?? 0) > 0 &&
                btn("debug-voiceprint-recompute", t.vpRecompute, () => c.recompute(), {
                  trusted: true,
                  disabled: busy,
                })}
            </>,
          )}
      </div>
    );
  };

  let body: React.ReactNode = null;
  switch (view.step) {
    case "closed":
    case "loading":
      body = note("…");
      break;
    case "status":
      body = (
        <>
          {view.prints.length ? (
            <ul data-testid="debug-voiceprint-prints" style={{ margin: "6px 0 0", paddingInlineStart: 18, fontSize: "calc(12px * var(--lk-fs-k, 1))" }}>
              {view.prints.map((p) => (
                <li key={`${p.device}.${p.model}`}>
                  {t.vpPrint.replaceAll("{device}", p.device).replaceAll("{n}", String(p.n))}
                  <span style={{ opacity: 0.6 }}> · {p.model}</span>
                </li>
              ))}
            </ul>
          ) : (
            note(t.vpNone)
          )}
          {!view.local && note(t.vpOff, "debug-voiceprint-off")}
          {view.filter && filterBlock(view.filter)}
          {view.cloud && cloudBlock(view.cloud, view.cloudOp, view.local && view.prints.length > 0, true)}
          {view.cloud && !view.prints.length && view.local && view.cloud.prints.length > 0 &&
            row(btn("debug-voiceprint-cloud-restore", t.vpCloudRestore, () => c.restoreFromAccount(), { primary: true, trusted: true }))}
          {windowUntil && (
            <div data-testid="debug-voiceprint-window" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {note(
                t.vpGrant.replaceAll(
                  "{time}",
                  new Date(windowUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                ),
              )}
              {btn("debug-voiceprint-window-end", t.vpGrantEnd, () => endVoiceprintWindow())}
            </div>
          )}
          {row(
            <>
              {view.local && btn("debug-voiceprint-enrol", t.vpEnrol, () => c.enrol(), { primary: true, trusted: true })}
              {view.local && d.testCapture && btn("debug-voiceprint-test", t.vpTest, () => void c.test(), { trusted: true })}
              {((view.local && view.prints.length > 0) || (view.cloud?.prints.length ?? 0) > 0) &&
                btn("debug-voiceprint-delete", t.vpDelete, () => c.askDelete(), { danger: true, trusted: true })}
              {btn("debug-voiceprint-close", t.vpClose, close)}
            </>,
          )}
        </>
      );
      break;
    case "consent":
      body = (
        <>
          <p data-testid="debug-voiceprint-consent" style={{ margin: "6px 0 0", fontSize: "calc(13px * var(--lk-fs-k, 1))", lineHeight: 1.45 }}>
            {t.vpConsent.replaceAll("{n}", `${ENROL_MIN}–${ENROL_MAX}`)}
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: "calc(12px * var(--lk-fs-k, 1))" }} className="pointer-events-auto">
            <input
              type="checkbox"
              data-testid="debug-voiceprint-keep-audio"
              checked={view.keepAudio}
              onChange={(e) => c.keepAudio(e.currentTarget.checked)}
            />
            {t.vpKeepAudio}
          </label>
          {row(
            <>
              {btn("debug-voiceprint-agree", t.vpAgree, () => void c.consent(), { primary: true, trusted: true })}
              {btn("debug-voiceprint-cancel", t.vpCancel, close)}
            </>,
          )}
        </>
      );
      break;
    case "recording": {
      const sentence = ENROL_SENTENCES[view.index % ENROL_SENTENCES.length]!;
      body = (
        <>
          <p style={{ margin: "6px 0 0", fontSize: "calc(12px * var(--lk-fs-k, 1))", opacity: 0.75 }}>{t.vpRead}</p>
          <p data-testid="debug-voiceprint-sentence" lang={/[぀-ヿ]/.test(sentence) ? "ja" : /[一-鿿]/.test(sentence) ? "zh" : "en"} style={{ margin: "6px 0 0", fontSize: "calc(18px * var(--lk-fs-k, 1))", lineHeight: 1.4, fontWeight: 500 }}>
            {sentence}
          </p>
          <p data-testid="debug-voiceprint-progress" style={{ margin: "8px 0 0", fontSize: "calc(12px * var(--lk-fs-k, 1))", fontVariantNumeric: "tabular-nums" }}>
            {t.vpProgress.replaceAll("{n}", String(view.kept)).replaceAll("{total}", String(ENROL_MAX))}
          </p>
          {view.again && (
            <p data-testid="debug-voiceprint-again" data-reason={view.again} role="status" style={{ margin: "4px 0 0", fontSize: "calc(12px * var(--lk-fs-k, 1))", color: DANGER }}>
              {again[view.again]}
            </p>
          )}
          {row(
            <>
              {btn("debug-voiceprint-save", t.vpSave, () => c.save(), { primary: true, disabled: view.kept < ENROL_MIN })}
              {btn("debug-voiceprint-skip", t.vpSkip, () => c.skip())}
              {btn("debug-voiceprint-cancel", t.vpCancel, close)}
            </>,
          )}
        </>
      );
      break;
    }
    case "saving":
      body = note(t.vpSaving);
      break;
    case "saved":
      body = (
        <>
          {note(t.vpSaved, "debug-voiceprint-saved")}
          {view.cloud && cloudBlock(view.cloud, view.cloudOp, true, false)}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
    case "confirm-delete":
      body = (
        <>
          <p data-testid="debug-voiceprint-confirm" style={{ margin: "6px 0 0", fontSize: "calc(13px * var(--lk-fs-k, 1))" }}>
            {t.vpDeleteConfirm}
          </p>
          {row(
            <>
              {btn("debug-voiceprint-delete-yes", t.vpDeleteYes, () => void c.confirmDelete(), {
                danger: true,
                trusted: true,
              })}
              {btn("debug-voiceprint-cancel", t.vpCancel, () => void c.open())}
            </>,
          )}
        </>
      );
      break;
    case "deleted":
      body = (
        <>
          {note(t.vpDeleted, "debug-voiceprint-deleted")}
          {view.cloudError &&
            note(t.vpCloudFailed.replaceAll("{error}", view.cloudError), "debug-voiceprint-cloud-error")}
          {/* His recordings in My Files: a separate question, never deleted with the voiceprint. */}
          {view.recordings && view.recordings.state !== "done" && (
            <>
              {note(t.vpRecDeleteOffer.replaceAll("{n}", String(view.recordings.n)), "debug-voiceprint-recordings-offer")}
              {view.recordings.state === "failed" &&
                note(t.vpCloudFailed.replaceAll("{error}", view.recordings.error ?? ""), "debug-voiceprint-recordings-error")}
              {row(
                btn("debug-voiceprint-recordings-delete", t.vpRecDeleteYes, () => void c.deleteRecordings(), {
                  danger: true,
                  trusted: true,
                  disabled: view.recordings.state === "busy",
                }),
              )}
            </>
          )}
          {view.recordings?.state === "done" && note(t.vpRecDeleted, "debug-voiceprint-recordings-deleted")}
          {/* The recordings kept on the Mac: their own question, kept unless he taps delete. */}
          {view.mac && (view.mac.state === "offer" || view.mac.state === "busy") && (
            <>
              {note(t.vpMacRecOffer.replaceAll("{n}", String(view.mac.n)), "debug-voiceprint-mac-recordings-offer")}
              {view.mac.error &&
                note(t.vpFailed.replaceAll("{error}", view.mac.error), "debug-voiceprint-mac-recordings-error")}
              {row(
                <>
                  {btn("debug-voiceprint-mac-recordings-keep", t.vpMacRecKeep, () => c.keepMacRecordings(), {
                    primary: true,
                    disabled: view.mac.state === "busy",
                  })}
                  {btn("debug-voiceprint-mac-recordings-delete", t.vpMacRecYes, () => void c.deleteMacRecordings(), {
                    danger: true,
                    trusted: true,
                    disabled: view.mac.state === "busy",
                  })}
                </>,
              )}
            </>
          )}
          {view.mac?.state === "done" && note(t.vpMacRecDeleted, "debug-voiceprint-mac-recordings-deleted")}
          {view.mac?.state === "kept" && note(t.vpMacRecKept, "debug-voiceprint-mac-recordings-kept")}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
    case "test": {
      const word = { me: t.vpTestMe, other: t.vpTestOther, unknown: t.vpTestUnknown } as const;
      const why: Record<string, string> = {
        short: t.vpTestWhyShort,
        noise: t.vpTestWhyNoise,
        between: t.vpTestWhyBetween,
        "no-print": t.vpTestWhyNoPrint,
      };
      const num = (x: number | undefined, d: number) => (typeof x === "number" ? x.toFixed(d) : "–");
      const f = view.filter;
      const filterOn = !!f && f.flag && !f.paused && f.state === "on";
      body = (
        <>
          {note(t.vpTestIntro, "debug-voiceprint-test-intro")}
          {!view.listening && !view.error && note(t.vpTestStarting)}
          {view.error && note(t.vpFailed.replaceAll("{error}", view.error), "debug-voiceprint-error")}
          {view.results.length > 0 && (
            <ul data-testid="debug-voiceprint-test-results" style={{ margin: "8px 0 0", padding: 0, listStyle: "none", fontSize: "calc(12px * var(--lk-fs-k, 1))", fontVariantNumeric: "tabular-nums" }}>
              {view.results.map((r, i) => {
                const mb = r.model ? (view.bands ?? DEFAULT_BANDS)[r.model] : undefined;
                const band = bandFor(mb, r.speechS);
                return (
                  <li
                    key={view.tally.me + view.tally.other + view.tally.unknown - i}
                    data-testid="debug-voiceprint-test-result"
                    data-decision={r.decision}
                    style={{ padding: "6px 0", borderTop: i ? `1px solid ${line(15)}` : undefined, opacity: i ? 0.7 : 1 }}
                  >
                    {r.decision === "unreachable" ? (
                      t.vpTestNoMac
                    ) : (
                      <>
                        <strong style={{ color: DECISION_HUE[r.decision], fontSize: "calc(14px * var(--lk-fs-k, 1))" }}>
                          {DECISION_MARK[r.decision]} {word[r.decision]}
                        </strong>
                        {r.decision === "unknown" && r.reason && why[r.reason] && <span> · {why[r.reason]}</span>}
                        <div>
                          {t.vpTestScore
                            .replaceAll("{score}", num(r.score, 3))
                            .replaceAll("{device}", r.device ?? "–")
                            .replaceAll("{model}", r.model ?? "–")
                            .replaceAll("{speech}", num(r.speechS, 1))
                            .replaceAll("{snr}", num(r.snrDb, 1))}
                        </div>
                        {mb && (
                          <div style={{ opacity: 0.75 }} data-testid="debug-voiceprint-test-lines">
                            {(band
                              ? t.vpTestLines.replaceAll("{me}", band.me.toFixed(2)).replaceAll("{other}", band.other.toFixed(2)).replaceAll("{s}", String(band.minS))
                              : ""
                            ) +
                              (band ? " " : "") +
                              t.vpTestGate.replaceAll("{s}", String(mb.minSpeechS)).replaceAll("{snr}", String(mb.minSnrDb))}
                          </div>
                        )}
                        {r.filtered && <div data-testid="debug-voiceprint-test-filter">{r.filtered === "stopped" ? t.vpTestStopped : t.vpTestWould}</div>}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p data-testid="debug-voiceprint-test-tally" style={{ margin: "8px 0 0", fontSize: "calc(12px * var(--lk-fs-k, 1))", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {t.vpTestTally
              .replaceAll("{me}", String(view.tally.me))
              .replaceAll("{other}", String(view.tally.other))
              .replaceAll("{unknown}", String(view.tally.unknown))}
          </p>
          {view.results.length > 0 && note(t.vpTestOthers, "debug-voiceprint-test-others")}
          <div data-testid="debug-voiceprint-test-flag" data-state={filterOn ? "on" : (f?.state ?? "off")} style={{ marginTop: 10 }}>
            {note(!f || !f.flag || f.paused ? t.vpFilterOff : filterOn ? t.vpFilterOn : t.vpFilterWaiting)}
            <a
              href={FILTER_FLAG_URL}
              target="_blank"
              rel="noopener"
              className="pointer-events-auto"
              style={{ fontSize: "calc(12px * var(--lk-fs-k, 1))", color: "inherit", textDecoration: "underline" }}
            >
              {t.vpTestFlag}
            </a>
          </div>
          {row(btn("debug-voiceprint-test-done", t.vpTestDone, () => c.endTest(), { primary: true }))}
        </>
      );
      break;
    }
    case "error":
      body = (
        <>
          {note(t.vpFailed.replaceAll("{error}", view.error), "debug-voiceprint-error")}
          {row(btn("debug-voiceprint-close", t.vpClose, close))}
        </>
      );
      break;
  }
  return (
    <section
      role="dialog"
      aria-label={t.vpTitle}
      data-testid="debug-voiceprint"
      data-step={view.step}
      className="pointer-events-auto"
      style={{
        // The menu's glass (DebugChat.tsx INPUT_BG): readable over any page.
        background: "color-mix(in oklch, var(--background) 96%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        width: "100%",
        boxSizing: "border-box",
        maxHeight: "70vh",
        overflowY: "auto",
        padding: "10px 12px 12px",
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: line(25),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: "calc(13px * var(--lk-fs-k, 1))" }}>{t.vpTitle}</strong>
        <button
          type="button"
          data-testid="debug-voiceprint-x"
          aria-label={t.vpClose}
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
          className="tap-40 pointer-events-auto"
          style={{ background: "transparent", border: 0, color: "inherit", fontSize: "calc(12px * var(--lk-fs-k, 1))", opacity: 0.6, cursor: "pointer" }}
        >
          ✕
        </button>
      </div>
      {body}
    </section>
  );
}

/**
 * The tiny mark after a voice line the Mac verified as his voice (SpeakerTag
 * decision "me"). Its own glyph, a sound wave, not a ✓: a tick reads as
 * "read" or "done" (owner, 2026-11-11: "是已读还是已经处理？"), and the chat
 * keeps ✓ for done and answered. Its words (`label`) are the tooltip on
 * hover and a bubble on a tap or long press, so a phone can read them too.
 */
export function VoiceMark({ label }: { label: string }) {
  const [tip, setTip] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hide.current), []);
  const show = () => {
    setTip(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setTip(false), VOICE_TIP_MS);
  };
  return (
    <button
      type="button"
      data-testid="debug-chat-voice-verified"
      title={label}
      aria-label={label}
      className="pointer-events-auto relative ms-1 inline-flex select-none items-center align-baseline leading-none [-webkit-touch-callout:none]"
      style={{ fontSize: "0.8em", color: "oklch(0.62 0.15 150)", opacity: 0.85, background: "transparent", border: 0, padding: 0 }}
      onContextMenu={(e) => {
        e.preventDefault();
        show();
      }}
      onClick={(e) => {
        e.stopPropagation();
        show();
      }}
    >
      <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <path d="M3 6.5v3M6 4.5v7M9 3v10M12 5.5v5" />
      </svg>
      {tip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute start-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded px-1 fs-10 lk-halo"
        >
          {label}
        </span>
      )}
    </button>
  );
}

/** How long the voice mark's bubble stays up after a tap or long press. */
export const VOICE_TIP_MS = 1_500;
