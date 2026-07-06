import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

// Core FSRS review loop, ported from the Next app: load the next due card, show
// it, grade it (again/hard/good/easy), advance to the card the server hands back.
type NextCard = { url: string | null; title?: string | null };
type ReviewResult = {
  ok: boolean;
  due?: string;
  nextUrl: string | null;
  nextTitle?: string | null;
};

const GRADES = [
  { key: "again", label: "Again" },
  { key: "hard", label: "Hard" },
  { key: "good", label: "Good" },
  { key: "easy", label: "Easy" },
] as const;

export function ReviewPage() {
  const [card, setCard] = useState<NextCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadNext = useCallback(async () => {
    setError(null);
    try {
      setCard(await api<NextCard>("/api/fsrs/next-url"));
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      setError(status === 401 ? "Please sign in to review." : String(e));
    }
  }, []);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const grade = useCallback(
    async (rating: string) => {
      if (!card?.url || busy) return;
      setBusy(true);
      try {
        const r = await api<ReviewResult>(
          `/api/fsrs/review/${rating}?url=${encodeURIComponent(card.url)}`,
          { method: "POST" },
        );
        setCard({ url: r.nextUrl, title: r.nextTitle });
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [card, busy],
  );

  // Keyboard shortcuts: 1-4 grade the current card (matches the userscript).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
      if (i >= 0) void grade(GRADES[i].key);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [grade]);

  if (error) return <p role="alert">{error}</p>;
  if (card === null) return <p>Loading…</p>;
  if (!card.url) return <p>Nothing due — you're all caught up. 🎉</p>;

  return (
    <section>
      <h1>Review</h1>
      <p style={{ fontSize: "1.1rem" }}>
        <a href={card.url} target="_blank" rel="noreferrer">
          {card.title || card.url}
        </a>
      </p>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        {GRADES.map((g, i) => (
          <button
            key={g.key}
            onClick={() => grade(g.key)}
            disabled={busy}
            style={{ padding: "0.5rem 1rem" }}
          >
            {g.label} <kbd style={{ opacity: 0.6 }}>{i + 1}</kbd>
          </button>
        ))}
      </div>
    </section>
  );
}
