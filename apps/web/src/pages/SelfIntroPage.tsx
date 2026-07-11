import { useState } from "react";
import { api } from "../lib/api";

// Self-intro: translate a self-introduction sentence to a target language and
// save it as a card. (AI translate — needs OPENAI_API_KEY on the Worker.)
export function SelfIntroPage() {
  const [answer, setAnswer] = useState("");
  const [language, setLanguage] = useState("ja");
  const [translated, setTranslated] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function translate() {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ translatedText?: string }>("/api/self-intro/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer, questionId: "q1", targetLanguage: language }),
      });
      setTranslated(r.translatedText ?? "");
    } catch (e: unknown) {
      setStatus(
        (e as { status?: number })?.status === 401 ? "Please sign in." : `Failed: ${String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!translated) return;
    setBusy(true);
    try {
      const r = await api<{ cardsCreated?: number }>("/api/self-intro/save-cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language, sentences: { q1: { text: translated, audioUrl: null } } }),
      });
      setStatus(`Saved ${r.cardsCreated ?? 0} cards.`);
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Self-intro</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 520 }}>
        <textarea
          placeholder="A sentence about yourself (English)"
          rows={2}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <input
          placeholder="Target language (e.g. ja)"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={translate} disabled={busy}>
            Translate
          </button>
          {translated ? (
            <button onClick={save} disabled={busy}>
              Save card
            </button>
          ) : null}
        </div>
      </div>
      {translated ? <p style={{ fontSize: "1.1rem", marginTop: "1rem" }}>{translated}</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
