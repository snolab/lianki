"use client";
import { useState } from "react";
import { MCP_REMOTE_URL } from "@/lib/agent-guide";

/** A one-time credential is copied only on a gesture, never stored or rendered as a URL. */
export function McpConnectionCopy({
  token,
  label,
  copiedLabel,
  onError,
}: {
  token: string;
  label: string;
  copiedLabel: string;
  onError(): void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${MCP_REMOTE_URL}/${token}`);
      setCopied(token);
    } catch {
      onError();
    }
  }
  return (
    <button
      type="button"
      data-testid="token-mcp-copy"
      onClick={copy}
      className="text-sm font-medium text-primary hover:underline"
    >
      {copied === token ? copiedLabel : label}
    </button>
  );
}
