"use client";
import { useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import type { ScopeId } from "@/lib/api-tokens";
import { agentGuide, guideStrings } from "@/lib/agent-guide";
import { longDate } from "@/lib/dates";
import { textOf } from "@/app/components/TokenPickers";

/**
 * The instructions for the user's own AI assistant, for one token
 * (lib/agent-guide.ts): built here from the token's scopes, name and expiry,
 * in the page's language. Never the token's secret: the text names it only as
 * <YOUR_TOKEN>, and the user hands the token over separately.
 */
export function useAgentGuide() {
  const g = useIntlayer("agent-guide");
  const { locale } = useLocale();
  const t = guideStrings(
    Object.fromEntries(
      Object.entries(g as Record<string, unknown>).map(([k, v]) => [k, textOf(v)]),
    ),
  );
  return (tok: { scopes: readonly ScopeId[]; name: string; expiresAt: string | null }) =>
    agentGuide({
      scopes: tok.scopes,
      t,
      name: tok.name,
      expires: tok.expiresAt ? longDate(tok.expiresAt, locale) : undefined,
    });
}

/** "Copy instructions for your AI assistant", then "Instructions copied". */
export function CopyGuideButton(p: { text: string; copy: string; copied: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-testid="token-guide-copy"
      onClick={() =>
        navigator.clipboard
          .writeText(p.text)
          .then(() => setDone(true))
          .catch(() => {})
      }
      className="text-sm font-medium bg-primary text-on-primary rounded px-3 py-1.5 hover:opacity-90"
    >
      {done ? p.copied : p.copy}
    </button>
  );
}

/** A token row's disclosure: the instructions, readable before they are copied. */
export function AgentGuide(p: {
  text: string;
  labels: { summary: string; copy: string; copied: string; noToken: string };
}) {
  return (
    <details className="mt-2 group" data-testid="token-guide">
      <summary className="cursor-pointer text-sm font-medium text-primary hover:underline w-fit">
        {p.labels.summary}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs opacity-80">{p.labels.noToken}</p>
        <CopyGuideButton text={p.text} copy={p.labels.copy} copied={p.labels.copied} />
        <pre
          data-testid="token-guide-text"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs font-mono p-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
        >
          {p.text}
        </pre>
      </div>
    </details>
  );
}
