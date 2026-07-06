import { useEffect, useState } from "react";
import type { FilterPattern, FilterType } from "@lianki/core";
import { api } from "../lib/api";

// Manage mobile exclude patterns (domains/urls/titles skipped on mobile).
// Reuses the shared FilterPattern type from @lianki/core.
type Prefs = { mobileExcludePatterns: FilterPattern[] };

export function SettingsPage() {
  const [patterns, setPatterns] = useState<FilterPattern[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState({ type: "domain" as FilterType, pattern: "" });

  useEffect(() => {
    api<Prefs>("/api/preferences")
      .then((p) => setPatterns(p.mobileExcludePatterns ?? []))
      .catch((e: unknown) =>
        setStatus((e as { status?: number })?.status === 401 ? "Please sign in." : String(e)),
      );
  }, []);

  async function save(next: FilterPattern[]) {
    setPatterns(next);
    try {
      await api("/api/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileExcludePatterns: next }),
      });
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    }
  }

  function add() {
    if (!draft.pattern.trim() || !patterns) return;
    const p: FilterPattern = {
      id: crypto.randomUUID(),
      type: draft.type,
      pattern: draft.pattern.trim(),
      isRegex: false,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    void save([...patterns, p]);
    setDraft({ type: "domain", pattern: "" });
  }

  if (patterns === null) return <p role="alert">{status ?? "Loading…"}</p>;

  return (
    <section>
      <h1>Settings</h1>
      <h2 style={{ fontSize: "1rem" }}>Mobile exclude patterns</h2>
      <ul style={{ lineHeight: 1.9, paddingLeft: 0, listStyle: "none" }}>
        {patterns.map((p) => (
          <li key={p.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={() =>
                save(patterns.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)))
              }
            />
            <code>
              {p.type}: {p.pattern}
            </code>
            <button onClick={() => save(patterns.filter((x) => x.id !== p.id))}>✕</button>
          </li>
        ))}
        {patterns.length === 0 ? <li style={{ color: "#888" }}>None yet.</li> : null}
      </ul>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <select
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value as FilterType })}
        >
          <option value="domain">domain</option>
          <option value="url">url</option>
          <option value="title">title</option>
        </select>
        <input
          placeholder="pattern"
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
        />
        <button onClick={add}>Add</button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
