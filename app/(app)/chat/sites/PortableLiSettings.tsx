"use client";
import { useEffect, useState } from "react";
import {
  PORTABLE_SETTINGS_REQUEST,
  PORTABLE_SETTINGS_STATE,
  type PortableSettingsRequest,
  type PortableSettingsState,
} from "@/src/portable-li-settings-wire";
import type { PortableLiStrings } from "@/src/portable-li-strings";
import { siteKey } from "@/src/pill-chat-trust";
const dispatch = (value: PortableSettingsRequest) =>
  document.dispatchEvent(
    new CustomEvent(PORTABLE_SETTINGS_REQUEST, { detail: JSON.stringify(value) }),
  );
export function parsePortableSettingsState(detail: unknown): PortableSettingsState | null {
  if (typeof detail !== "string" || detail.length > 32768) return null;
  try {
    const v = JSON.parse(detail);
    if (
      v?.installed !== true ||
      !["unknown", "all", "off"].includes(v.consent) ||
      !Array.isArray(v.excluded) ||
      v.excluded.length > 512 ||
      !v.excluded.every((h: unknown) => typeof h === "string" && siteKey(h) === h)
    )
      return null;
    return {
      installed: true,
      consent: v.consent,
      excluded: v.excluded,
      ...(v.error === true ? { error: true } : {}),
    };
  } catch {
    return null;
  }
}
export default function PortableLiSettings({
  strings: t,
  notReady,
}: {
  strings: PortableLiStrings;
  notReady: string;
}) {
  const [state, setState] = useState<PortableSettingsState | null>(null),
    [host, setHost] = useState(""),
    [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const receive = (event: Event) => {
      const value = parsePortableSettingsState((event as CustomEvent).detail);
      if (value) {
        setState(value);
        setWaiting(false);
      }
    };
    document.addEventListener(PORTABLE_SETTINGS_STATE, receive);
    dispatch({ op: "state" });
    const timeout = setTimeout(() => setTimedOut(true), 3000);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener(PORTABLE_SETTINGS_STATE, receive);
    };
  }, []);
  const request = (value: PortableSettingsRequest) => {
    setWaiting(true);
    dispatch(value);
  };
  const button = "rounded-lg border border-current/30 px-3 py-2 text-sm disabled:opacity-50";
  return (
    <section
      className="mb-6 rounded-xl border border-current/20 p-4"
      aria-labelledby="portable-li-settings-title"
      data-portable-settings
    >
      <h2 id="portable-li-settings-title" className="font-semibold">
        {t.title}
      </h2>
      <p className="mt-2 text-sm">{t.consentBody}</p>
      {!state ? (
        <p role="status" className="mt-2 text-sm">
          {timedOut ? notReady : t.connecting}
        </p>
      ) : (
        <>
          <p role="status" className="mt-2 text-sm">
            {state.error ? t.failed : state.consent === "all" ? t.allowAll : t.disabled}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {state.consent !== "all" ? (
              <button
                type="button"
                className={button}
                disabled={waiting}
                onClick={() => request({ op: "allow" })}
              >
                {t.allowAll}
              </button>
            ) : (
              <button
                type="button"
                className={button}
                disabled={waiting}
                onClick={() => request({ op: "off" })}
              >
                {t.disableAll}
              </button>
            )}
            <button
              type="button"
              className={button}
              onClick={() => {
                setWaiting(false);
                dispatch({ op: "state" });
              }}
            >
              {t.retry}
            </button>
          </div>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const clean = siteKey(host.trim().toLowerCase());
              if (clean) {
                request({ op: "exclude", host: clean, excluded: true });
                setHost("");
              }
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-lg border border-current/30 px-3 py-2 text-sm"
              aria-label={t.exclude}
              placeholder="example.com"
              maxLength={253}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <button className={button} disabled={waiting || !siteKey(host.trim().toLowerCase())}>
              {t.exclude}
            </button>
          </form>
          <ul className="mt-3 space-y-2">
            {state.excluded.map((site) => (
              <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={site}>
                <span className="break-all">{site}</span>
                <button
                  type="button"
                  className={button}
                  disabled={waiting}
                  onClick={() => request({ op: "exclude", host: site, excluded: false })}
                >
                  {t.removeExclusion}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
