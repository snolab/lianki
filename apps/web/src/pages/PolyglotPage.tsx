import { useState } from "react";
import { api } from "../lib/api";

// Polyglot: translate a Q&A into several languages, then save each as a card.
// (Uses the AI translate/save-cards endpoints — needs OPENAI_API_KEY on the
// Worker.)
type Cell = { question: string; answer: string };
type Matrix = Record<string, Record<string, Cell>>; // { questionId: { lang: Cell } }

const QID = "q1";

export function PolyglotPage() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [langs, setLangs] = useState("es, fr, ja");
  const [matrix, setMatrix] = useState<Matrix>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function translate() {
    if (!question.trim() || !answer.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    const targets = langs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const row: Record<string, Cell> = { en: { question, answer } };
    try {
      for (const lang of targets) {
        const r = await api<{
          translatedQuestion?: string;
          translatedAnswer?: string;
          question?: string;
          answer?: string;
        }>("/api/polyglot/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, answer, targetLanguage: lang, sourceLanguage: "en" }),
        });
        row[lang] = {
          question: r.translatedQuestion ?? r.question ?? question,
          answer: r.translatedAnswer ?? r.answer ?? answer,
        };
      }
      setMatrix({ [QID]: row });
      setStatus("Translated.");
    } catch (e: unknown) {
      setStatus(
        (e as { status?: number })?.status === 401 ? "Please sign in." : `Failed: ${String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!Object.keys(matrix).length) return;
    setBusy(true);
    try {
      const r = await api<{ cardsCreated?: number }>("/api/polyglot/save-cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ matrix }),
      });
      setStatus(`Saved ${r.cardsCreated ?? 0} cards.`);
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const row = matrix[QID];
  return (
    <section>
      <h1>Polyglot</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 520 }}>
        <input
          placeholder="Question (English)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <input
          placeholder="Answer (English)"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <input
          placeholder="Target languages (comma-separated)"
          value={langs}
          onChange={(e) => setLangs(e.target.value)}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={translate} disabled={busy}>
            Translate
          </button>
          {row ? (
            <button onClick={save} disabled={busy}>
              Save cards
            </button>
          ) : null}
        </div>
      </div>
      {row ? (
        <table style={{ marginTop: "1rem", borderCollapse: "collapse" }}>
          <tbody>
            {Object.entries(row).map(([lang, cell]) => (
              <tr key={lang}>
                <td style={{ padding: "0.25rem 0.75rem 0.25rem 0", color: "#888" }}>{lang}</td>
                <td style={{ padding: "0.25rem 0" }}>
                  {cell.question} — {cell.answer}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
