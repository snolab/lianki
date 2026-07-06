import { useState } from "react";
import { api } from "../lib/api";

// AI example-sentence generator (POST /api/ai-sentences/generate). Requires a
// valid OPENAI_API_KEY on the Worker; otherwise the endpoint returns an error.
type Sentence = { word: string; sentence: string; reading: string; explanation: string };

export function AiPage() {
  const [word, setWord] = useState("");
  const [language, setLanguage] = useState("Japanese");
  const [result, setResult] = useState<Sentence | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!word.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    setResult(null);
    try {
      setResult(
        await api<Sentence>("/api/ai-sentences/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ word: word.trim(), language }),
        }),
      );
    } catch (e: unknown) {
      const s = (e as { status?: number })?.status;
      setStatus(s === 401 ? "Please sign in." : `Failed (is OPENAI_API_KEY set?): ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>AI vocabulary</h1>
      <form onSubmit={generate} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input placeholder="word" value={word} onChange={(e) => setWord(e.target.value)} />
        <input
          placeholder="language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Generating…" : "Generate sentence"}
        </button>
      </form>
      {result ? (
        <div style={{ marginTop: "1rem" }}>
          <p style={{ fontSize: "1.15rem" }}>{result.sentence}</p>
          <p style={{ color: "#666" }}>{result.reading}</p>
          <p>{result.explanation}</p>
        </div>
      ) : null}
      {status ? <p role="alert">{status}</p> : null}
    </section>
  );
}
