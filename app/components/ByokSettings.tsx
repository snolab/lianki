"use client";

// Settings → 「自己的 AI」 (docs/byok.md): the learner's own AI provider and
// API key, used from this browser for the reader's translations and word
// meanings. The key stays in this browser (`lk:byok`); the provider, base URL
// and model may follow the account when 「同步到我的账号」 is ticked
// (`byok.backend`, docs/prefs-sync.md). Turning it on the first time needs the
// privacy notice acknowledged (「我明白」), per notice version.
//
// 「经 Lianki 转发（不保存）」 (`backend.relay`) is offered only for a preset
// on the relay's allowlist (`relay` in lib/byok/presets.ts): calls then go
// through `/api/byok/proxy`, which forwards and keeps nothing. A custom
// backend is never relayed. A failed browser-direct test of an allowlisted
// provider suggests turning it on.
//
// The key syncing (managed mode, the server keeps the key encrypted) is only
// drawn, disabled, behind the `byok.sync` flag: no API, table or encryption
// exists until the owner approves the storage design.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { BYOK_PRESETS, presetOf } from "@/lib/byok/presets";
import {
  BYOK_EVENT,
  checkBaseUrl,
  cleanBackend,
  emptyDevice,
  gapOf,
  hasAck,
  loadDevice,
  loadSyncedBackend,
  relayable,
  removeDevice,
  saveAck,
  saveDevice,
  saveSyncedBackend,
  withEnabled,
  type ByokBackend,
  type ByokDevice,
} from "@/lib/byok/config";
import { byokModels, testByok, type ByokErrorKind } from "@/lib/byok/call";
import { useBackToClose } from "@/lib/use-back-to-close";
import { markClean } from "@/lib/page-dirty";

type Status = { tone: "ok" | "err" | "info"; text: string } | null;

const FIELD =
  "w-full rounded-lg border border-[oklch(0.5_0.02_250/0.35)] bg-[oklch(1_0_0/0.6)] px-3 py-2 text-base outline-none focus:border-[oklch(0.6_0.14_250)] focus:ring-1 focus:ring-[oklch(0.6_0.14_250)] dark:bg-[oklch(0.25_0.01_250/0.6)]";
const BTN =
  "min-h-11 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-50 pointer-fine:min-h-9";
/** The field (its data-testid) to fill in for each gap. */
const gapField = {
  url: "base-url",
  "server-only": "base-url",
  relay: "base-url",
  model: "model",
  key: "key",
} as const;
const TONE = {
  ok: "text-[oklch(0.5_0.14_155)] dark:text-[oklch(0.78_0.14_155)]",
  err: "text-[oklch(0.52_0.17_30)] dark:text-[oklch(0.76_0.14_30)]",
  info: "opacity-80",
} as const;

/** The form before anything is chosen: the model stays empty until the provider lists its own. */
const blankForm = (): ByokDevice => {
  const d = emptyDevice();
  return { ...d, backend: { ...d.backend, model: "" } };
};

export function ByokSettings({
  showKeySync = false,
  signedIn = true,
}: {
  showKeySync?: boolean;
  /** Syncing needs a (free) account; browser-only mode needs none. */
  signedIn?: boolean;
}) {
  const c = useIntlayer("byok-settings");
  const [device, setDevice] = useState<ByokDevice>(blankForm);
  const [synced, setSynced] = useState(false);
  const [acked, setAcked] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  /** The last browser-direct test failed the way a relay would fix (CORS / unreachable). */
  const [suggestRelay, setSuggestRelay] = useState(false);
  /** Ticked while the form is incomplete: it turns on when the form is saved. */
  const [wanted, setWanted] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const keyEdited = useRef(false);
  const modelsAsk = useRef(0);

  const reload = useCallback(() => {
    const d = loadDevice() ?? blankForm();
    const s = loadSyncedBackend();
    setDevice(s ? { ...d, backend: s } : d);
    setSynced(!!s);
    setAcked(hasAck());
  }, []);
  useEffect(() => {
    reload();
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "byok.backend") reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("lk:byok")) reload();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener("storage", onStorage);
    };
  }, [reload]);

  const preset = presetOf(device.backend.provider) ?? BYOK_PRESETS[0];
  const pageHost = typeof location === "undefined" ? null : location.host;
  const gap = gapOf(device.backend, device.apiKey, pageHost);
  const gapText = useMemo(
    () =>
      gap === "url" || gap === "server-only"
        ? c.errUrl.value
        : gap === "relay"
          ? c.errRelay.value.replaceAll("{name}", preset.name)
          : gap === "model"
            ? c.errModel.value
            : gap === "key"
              ? c.errKey.value
              : null,
    [gap, c, preset.name],
  );

  const errorText = (kind: ByokErrorKind, status?: number) => {
    const s = String(status ?? "");
    switch (kind) {
      case "bad-url":
        return c.errUrl.value;
      case "auth":
        return c.errAuth.value.replace("{status}", s);
      case "http":
        return c.errHttp.value.replace("{status}", s);
      case "local":
        return c.errLocal.value;
      case "opaque-auth":
        return c.errOpaqueAuth.value;
      case "timeout":
        return c.errTimeout.value;
      case "empty":
        return c.errEmpty.value;
      case "relay-refused":
        return c.errRelayRefused.value;
      case "rate":
        return c.errRate.value;
      case "too-large":
        return c.errTooLarge.value;
      default:
        return c.errCors.value;
    }
  };

  const setBackend = (b: Partial<ByokBackend>) =>
    setDevice((d) => ({ ...d, backend: { ...d.backend, ...b } }));

  /**
   * The provider's own model list, with the key the user just entered; the
   * preset's model is chosen when the provider offers it. Silent on failure:
   * the model can always be typed.
   */
  const loadModels = async (d: ByokDevice) => {
    const p = presetOf(d.backend.provider);
    if (!p) return;
    const ask = ++modelsAsk.current;
    const list = await byokModels(d.backend, d.apiKey.trim(), p);
    if (ask !== modelsAsk.current) return;
    setModels(list);
    if (list.includes(p.model))
      setDevice((cur) =>
        cur.backend.provider === p.id && !cur.backend.model
          ? { ...cur, backend: { ...cur.backend, model: p.model } }
          : cur,
      );
  };

  const pickProvider = (id: string) => {
    const p = presetOf(id);
    if (!p) return;
    setStatus(null);
    setSuggestRelay(false);
    modelsAsk.current++;
    setModels([]);
    const backend = p.id === "custom" ? device.backend : { baseUrl: p.baseUrl, model: "" };
    setBackend({ ...backend, provider: p.id, relay: undefined });
    // Never with the key in the field: it may belong to the provider just left.
    if (p.keyless)
      void loadModels({ ...device, apiKey: "", backend: { ...backend, provider: p.id } });
  };

  /** Store the form on this device (and the backend on the account, when synced). */
  const persist = (d: ByokDevice): boolean => {
    const b = cleanBackend(d.backend);
    if (!b) {
      setStatus({ tone: "err", text: c.errUrl.value });
      return false;
    }
    const next = { ...d, backend: b, apiKey: d.apiKey.trim() };
    saveDevice(next);
    if (synced) {
      saveSyncedBackend(b);
      notePrefWrite();
    }
    setDevice(next);
    markClean();
    return true;
  };

  const save = () => {
    if (gapText) return setStatus({ tone: "err", text: gapText });
    if (!persist(device)) return;
    setStatus({ tone: "ok", text: c.saved.value });
    if (wanted) {
      setWanted(false);
      turn(true);
    }
  };

  const turn = (on: boolean) => {
    if (on && gap) {
      setWanted(true);
      document.querySelector<HTMLElement>(`[data-testid="byok-${gapField[gap]}"]`)?.focus();
      return;
    }
    setWanted(false);
    // Only ticked, never turned on: nothing is stored, so nothing to undo.
    if (!on && !device.enabled) return;
    const r = withEnabled(device, on, acked);
    if (!r.ok) return setNotice(true);
    if (persist(r.device)) setStatus(null);
  };

  const acknowledge = () => {
    saveAck();
    setAcked(true);
    setNotice(false);
    const r = withEnabled(device, true, true);
    if (r.ok) persist(r.device);
  };

  const test = async (backend: ByokBackend = device.backend) => {
    const g = gapOf(backend, device.apiKey, pageHost);
    if (g) return setStatus({ tone: "err", text: gapText ?? c.errUrl.value });
    const u = checkBaseUrl(backend.baseUrl, pageHost);
    if (!u.ok) return setStatus({ tone: "err", text: c.errUrl.value });
    setBusy(true);
    setSuggestRelay(false);
    setStatus({ tone: "info", text: c.testing.value });
    const r = await testByok({
      backend: { ...backend, baseUrl: u.url },
      apiKey: device.apiKey.trim(),
      preset,
    });
    setBusy(false);
    // Browser-direct failed the way a relay fixes, and this provider may be relayed.
    const relayFixes =
      !r.ok && !backend.relay && !!preset.relay && (r.kind === "cors" || r.kind === "opaque-auth");
    setSuggestRelay(relayFixes && relayable(backend.provider, u.url));
    setStatus(
      r.ok
        ? { tone: "ok", text: c.testOk.value }
        : {
            tone: "err",
            text:
              relayFixes && relayable(backend.provider, u.url)
                ? `${errorText(r.kind, r.status)} ${c.corsTryRelay.value.replaceAll("{name}", preset.name)}`
                : errorText(r.kind, r.status),
          },
    );
  };

  /** 「经 Lianki 转发」 on (the suggestion's button), then test again. */
  const relayAndTest = () => {
    const b = { ...device.backend, relay: true };
    setBackend({ relay: true });
    void test(b);
  };

  const remove = () => {
    removeDevice();
    setShowKey(false);
    setWanted(false);
    setModels([]);
    const s = loadSyncedBackend();
    const d = blankForm();
    setDevice(s ? { ...d, backend: s } : d);
    markClean();
    setStatus({ tone: "ok", text: c.removed.value });
  };

  const toggleSync = (on: boolean) => {
    if (on) {
      const b = cleanBackend(device.backend);
      if (!b) return setStatus({ tone: "err", text: gapText ?? c.errUrl.value });
      saveSyncedBackend(b);
    } else saveSyncedBackend(null);
    notePrefWrite();
    setSynced(on);
  };

  const relayRow = preset.relay ? (
    <label className="flex items-start gap-3" data-testid="byok-relay-row">
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0"
        checked={!!device.backend.relay}
        onChange={(e) => {
          setSuggestRelay(false);
          setStatus(null);
          setBackend({ relay: e.target.checked || undefined });
        }}
        data-testid="byok-relay"
      />
      <span>
        <span className="block font-medium">{c.relay}</span>
        <span className="block text-sm opacity-75">
          {c.relayHint.value.replaceAll("{name}", preset.name)}
        </span>
      </span>
    </label>
  ) : null;

  useBackToClose(notice, () => setNotice(false));

  const policy = preset.policyUrl ? (
    <a
      href={preset.policyUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {c.policy.value.replace("{name}", preset.name)}
    </a>
  ) : null;

  return (
    <section className="mb-10 max-w-xl" data-section="byok" data-testid="byok-settings">
      <h2 className="mb-2 text-2xl font-semibold">{c.heading}</h2>
      <p className="mb-1 opacity-80">{c.intro}</p>
      <p className="mb-4 text-sm opacity-70">{c.serverSide}</p>

      <label className="flex items-start gap-3 rounded-lg bg-[oklch(0.5_0.02_250/0.08)] p-3">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0"
          checked={wanted || (device.enabled && acked)}
          onChange={(e) => turn(e.target.checked)}
          data-testid="byok-enable"
        />
        <span>
          <span className="block font-medium">{c.enable}</span>
          <span className="mt-1 block text-sm opacity-75" data-testid="byok-notice-short">
            {c.noticeShort}
            {device.backend.relay && <span className="mt-1 block">{c.noticeRelay}</span>}
          </span>
          {wanted && gapText && (
            <span
              className={`mt-1 block text-sm ${TONE.err}`}
              role="status"
              data-testid="byok-enable-gap"
            >
              {gapText}
            </span>
          )}
        </span>
      </label>

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{c.provider}</span>
          <select
            className={FIELD}
            value={preset.id}
            onChange={(e) => pickProvider(e.target.value)}
            data-testid="byok-provider"
          >
            {BYOK_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === "custom" ? c.custom.value : p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{c.baseUrl}</span>
          <input
            className={`${FIELD} font-mono text-sm`}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={device.backend.baseUrl}
            placeholder="https://"
            onChange={(e) => setBackend({ baseUrl: e.target.value })}
            data-testid="byok-base-url"
          />
          <span className="text-xs opacity-70">{c.baseUrlHint}</span>
          {preset.id === "ollama" && <span className="text-xs opacity-70">{c.ollamaHint}</span>}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{c.model}</span>
          <input
            className={`${FIELD} font-mono text-sm`}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            list="byok-models"
            value={device.backend.model}
            onChange={(e) => setBackend({ model: e.target.value })}
            data-testid="byok-model"
          />
          <datalist id="byok-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {!models.length && <span className="text-xs opacity-70">{c.modelHint}</span>}
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="byok-key" className="text-sm font-medium">
            {c.apiKey}
          </label>
          <div className="flex gap-2">
            <input
              id="byok-key"
              className={`${FIELD} font-mono text-sm`}
              type={showKey ? "text" : "password"}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              // Never to a cloud spell checker: the key is a secret.
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore
              value={device.apiKey}
              onChange={(e) => {
                keyEdited.current = true;
                setDevice((d) => ({ ...d, apiKey: e.target.value }));
              }}
              onBlur={() => {
                if (!keyEdited.current || !device.apiKey.trim()) return;
                keyEdited.current = false;
                void loadModels(device);
              }}
              data-testid="byok-key"
            />
            <button
              type="button"
              className={`${BTN} shrink-0 bg-[oklch(0.5_0.02_250/0.12)] hover:bg-[oklch(0.5_0.02_250/0.2)]`}
              onClick={() => setShowKey((v) => !v)}
              aria-pressed={showKey}
            >
              {showKey ? c.hide : c.show}
            </button>
          </div>
          <span className="text-xs opacity-70">
            {preset.keyless ? c.keyless : device.backend.relay ? c.keyHereRelay : c.keyHere}
          </span>
        </div>

        {relayRow}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={`${BTN} bg-[oklch(0.55_0.15_250)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.15_250)]`}
            data-testid="byok-save"
          >
            {c.save}
          </button>
          <button
            type="button"
            className={`${BTN} bg-[oklch(0.5_0.02_250/0.12)] hover:bg-[oklch(0.5_0.02_250/0.2)]`}
            onClick={() => void test(device.backend)}
            disabled={busy}
            data-testid="byok-test"
          >
            {busy ? c.testing : c.test}
          </button>
          <button
            type="button"
            className={`${BTN} text-[oklch(0.52_0.17_30)] hover:bg-[oklch(0.6_0.17_30/0.12)] dark:text-[oklch(0.76_0.14_30)]`}
            onClick={remove}
            data-testid="byok-remove"
          >
            {c.remove}
          </button>
        </div>
        {status && (
          <p className={`text-sm ${TONE[status.tone]}`} role="status" data-testid="byok-status">
            {status.text}
          </p>
        )}
        {suggestRelay && !device.backend.relay && (
          <button
            type="button"
            className={`${BTN} self-start bg-[oklch(0.5_0.02_250/0.12)] hover:bg-[oklch(0.5_0.02_250/0.2)]`}
            onClick={relayAndTest}
            disabled={busy}
            data-testid="byok-relay-try"
          >
            {c.relayTry}
          </button>
        )}

        <label className={`mt-2 flex items-start gap-3 ${signedIn ? "" : "opacity-70"}`}>
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0"
            checked={signedIn && synced}
            disabled={!signedIn}
            onChange={(e) => toggleSync(e.target.checked)}
            data-testid="byok-sync"
          />
          <span>
            <span className="block font-medium">{c.sync}</span>
            <span className="block text-sm opacity-75">{c.syncHint}</span>
            {!signedIn && (
              <a
                href="/sign-in?to=%2Fpreferences"
                className="block text-sm font-medium underline underline-offset-2"
                data-testid="byok-sync-sign-in"
              >
                {c.syncSignIn}
              </a>
            )}
          </span>
        </label>
        {showKeySync && (
          <label className="flex items-start gap-3 opacity-60" data-testid="byok-key-sync">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled checked={false} />
            <span>
              <span className="block font-medium">
                {c.keySync}
                <span className="ms-2 rounded-full bg-[oklch(0.62_0.12_250/0.16)] px-2 py-0.5 text-xs">
                  {c.soon}
                </span>
              </span>
              <span className="block text-sm">{c.keySyncWarn}</span>
            </span>
          </label>
        )}
      </form>

      {notice && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-[oklch(0_0_0/0.4)] p-4 sm:items-center"
          onClick={() => setNotice(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="byok-notice-title"
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-[oklch(0.99_0_0)] p-5 shadow-xl dark:bg-[oklch(0.24_0.01_250)]"
            onClick={(e) => e.stopPropagation()}
            data-testid="byok-notice"
          >
            <h3 id="byok-notice-title" className="mb-3 text-lg font-semibold">
              {c.noticeTitle}
            </h3>
            <ul className="mb-3 list-disc space-y-2 ps-5 text-sm">
              <li>{c.noticeWhat}</li>
              <li>{c.noticeWhere}</li>
              <li>
                {c.noticeControl} {policy}
              </li>
              <li>{c.noticeCustom}</li>
              <li>{c.noticeRelay}</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={`${BTN} bg-[oklch(0.5_0.02_250/0.12)] hover:bg-[oklch(0.5_0.02_250/0.2)]`}
                onClick={() => setNotice(false)}
              >
                {c.cancel}
              </button>
              <button
                type="button"
                className={`${BTN} bg-[oklch(0.55_0.15_250)] text-[oklch(0.99_0_0)] hover:bg-[oklch(0.5_0.15_250)]`}
                onClick={acknowledge}
                data-testid="byok-ack"
                autoFocus
              >
                {c.ack}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
