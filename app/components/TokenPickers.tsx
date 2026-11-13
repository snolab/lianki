"use client";

import { useIntlayer } from "next-intlayer";
import {
  EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  OWNER_SCOPES,
  SCOPES,
  SCOPE_IDS,
  type ScopeId,
} from "@/lib/api-tokens";
import { isoDay } from "@/lib/dates";

/**
 * The permission and expiry pickers of a new API token (lib/api-tokens.ts):
 * Settings → API tokens (TokenManager) and /cli-login. Permissions come from
 * SCOPES (data); nothing outside it can be picked. The expiry has no default:
 * a duration from EXPIRY_DAYS or a date, at most MAX_EXPIRY_DAYS ahead.
 */
export type Expiry = { days: number } | { date: string } | null;

const SCOPE_TEXT: Record<ScopeId, { label: string; hint: string }> = {
  study: { label: "scopeStudy", hint: "scopeStudyHint" },
  "chat:read": { label: "scopeChatRead", hint: "scopeChatReadHint" },
  "chat:write": { label: "scopeChatWrite", hint: "scopeChatWriteHint" },
  "chat:ask": { label: "scopeChatAsk", hint: "scopeChatAskHint" },
  eval: { label: "scopeEval", hint: "scopeEvalHint" },
  progress: { label: "scopeProgress", hint: "scopeProgressHint" },
};

export function PermissionPicker(p: {
  value: ScopeId[];
  onChange: (v: ScopeId[]) => void;
  disabled?: boolean;
  /**
   * What the server offers this account (GET /api/token `scopes`): `eval` only
   * to a site owner. Absent (the CLI login page): everything but OWNER_SCOPES.
   */
  offered?: readonly ScopeId[];
}) {
  const c = useIntlayer("api-tokens") as unknown as Record<string, unknown>;
  const s = (k: string) => textOf(c[k]);
  const offered = p.offered ?? SCOPE_IDS.filter((id) => !OWNER_SCOPES.includes(id));
  const owner = offered.some((id) => OWNER_SCOPES.includes(id));
  return (
    <fieldset className="space-y-2" disabled={p.disabled}>
      <legend className="text-sm font-medium mb-1">{s("permissions")}</legend>
      {SCOPES.filter(({ id }) => offered.includes(id)).map(({ id }) => {
        const on = p.value.includes(id);
        return (
          <label key={id} className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              checked={on}
              onChange={() => p.onChange(on ? p.value.filter((x) => x !== id) : [...p.value, id])}
              data-scope={id}
            />
            <span>
              <span className="font-medium">{s(SCOPE_TEXT[id].label)}</span>{" "}
              <code className="text-xs opacity-60">{id}</code>
              <span className="block text-xs opacity-70">{s(SCOPE_TEXT[id].hint)}</span>
            </span>
          </label>
        );
      })}
      <p className="text-xs opacity-70">{s(owner ? "neverOwner" : "never")}</p>
    </fieldset>
  );
}

export function ExpiryPicker(p: {
  value: Expiry;
  onChange: (v: Expiry) => void;
  disabled?: boolean;
}) {
  const c = useIntlayer("api-tokens") as unknown as Record<string, unknown>;
  const s = (k: string) => textOf(c[k]);
  const today = Date.now();
  const min = isoDay(today + 86_400_000);
  const max = isoDay(today + (MAX_EXPIRY_DAYS - 1) * 86_400_000);
  const isDate = p.value !== null && "date" in p.value;
  return (
    <fieldset className="space-y-2" disabled={p.disabled}>
      <legend className="text-sm font-medium mb-1">{s("expiry")}</legend>
      <div className="flex flex-wrap gap-2">
        {EXPIRY_DAYS.map((n) => {
          const on = p.value !== null && "days" in p.value && p.value.days === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => p.onChange({ days: n })}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                on
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {s("days").replace("{n}", String(n))}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={isDate}
          onClick={() => p.onChange({ date: isDate ? (p.value as { date: string }).date : "" })}
          className={`px-3 py-1.5 rounded-full text-sm border ${
            isDate
              ? "bg-blue-600 border-blue-600 text-white"
              : "border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          {s("customDate")}
        </button>
      </div>
      {isDate && (
        <input
          type="date"
          min={min}
          max={max}
          value={(p.value as { date: string }).date}
          onChange={(e) => p.onChange({ date: e.target.value })}
          className="block border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-900"
          aria-label={s("customDate")}
        />
      )}
      <p className="text-xs opacity-70">{s("expiryHint")}</p>
    </fieldset>
  );
}

/** An intlayer node (or a plain string) as text: useIntlayer gives nodes; `.value` is the string. */
export const textOf = (v: unknown): string =>
  typeof v === "string" ? v : String((v as { value?: unknown } | null | undefined)?.value ?? "");

/** The expiry as the server takes it, or null when none is picked. */
export const expiryBody = (e: Expiry) =>
  !e ? null : "days" in e ? { days: e.days } : e.date ? { date: e.date } : null;
