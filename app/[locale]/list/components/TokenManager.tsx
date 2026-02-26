"use client";
import { useState, useEffect } from "react";

type Token = { id: string; name: string; createdAt: string };

export default function TokenManager() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/token")
      .then((r) => r.json())
      .then(setTokens);
  }, []);

  async function generate() {
    setLoading(true);
    setNewToken(null);
    const r = await fetch("/api/token", {
      method: "POST",
      body: JSON.stringify({ name: "Userscript" }),
      headers: { "content-type": "application/json" },
    });
    const data = await r.json();
    setNewToken(data.token);
    fetch("/api/token")
      .then((r) => r.json())
      .then(setTokens);
    setLoading(false);
  }

  async function revoke(id: string) {
    await fetch(`/api/token?id=${id}`, { method: "DELETE" });
    setTokens((t) => t.filter((x) => x.id !== id));
    if (newToken) setNewToken(null);
  }

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="my-8">
      <h2 className="text-xl font-semibold mb-2">API Tokens</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Use a token to authenticate the userscript in Safari or other environments where cookies
        don&apos;t work.
      </p>

      {newToken && (
        <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-md">
          <p className="text-sm font-medium mb-1">
            Copy this token — it won&apos;t be shown again:
          </p>
          <code className="block break-all text-xs bg-white dark:bg-gray-900 p-2 rounded select-all font-mono">
            {newToken}
          </code>
          <button
            onClick={copyToken}
            className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
      )}

      <ul className="space-y-2 mb-4">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-4 text-sm">
            <span>
              {t.name}{" "}
              <span className="text-gray-400 text-xs">
                · {new Date(t.createdAt).toLocaleDateString()}
              </span>
            </span>
            <button
              onClick={() => revoke(t.id)}
              className="text-red-500 hover:underline text-xs shrink-0"
            >
              Revoke
            </button>
          </li>
        ))}
        {tokens.length === 0 && <li className="text-gray-400 text-sm">No tokens yet.</li>}
      </ul>

      <button
        onClick={generate}
        disabled={loading}
        className="bg-blue-600 text-white text-sm py-2 px-4 rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Generating…" : "Generate new token"}
      </button>
    </section>
  );
}
