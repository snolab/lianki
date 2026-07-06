import { useState } from "react";
import { api } from "../lib/api";

// Add a card by URL (POST /api/fsrs/add). Rounds out the core loop: add →
// review → due.
type AddResult = { url?: string; title?: string };

export function AddPage() {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<AddResult>("/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), title: title.trim() || undefined }),
      });
      setStatus(`Added: ${r.title || r.url || url}`);
      setUrl("");
      setTitle("");
    } catch (e: unknown) {
      const s = (e as { status?: number })?.status;
      setStatus(s === 401 ? "Please sign in to add cards." : `Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Add a card</h1>
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}
      >
        <input
          type="url"
          required
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ padding: "0.5rem" }}
        />
        <input
          type="text"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ padding: "0.5rem" }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{ padding: "0.5rem 1rem", alignSelf: "flex-start" }}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
