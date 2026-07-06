import { useEffect, useState } from "react";
import type { FSRSNote } from "@lianki/core";
import { api } from "../lib/api";

// The /api/fsrs/due projection: a subset of the shared FSRSNote plus a
// human-readable `due`. Reusing the @lianki/core type keeps the client and the
// Worker in sync.
type DueCard = Pick<FSRSNote, "url" | "title" | "notes"> & { due?: string };
type DueResponse = { cards: DueCard[] };

export function DuePage() {
  const [cards, setCards] = useState<DueCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DueResponse>("/api/fsrs/due?limit=20")
      .then((r) => setCards(r.cards ?? []))
      .catch((e) => setError(e?.status === 401 ? "Please sign in to see due cards." : String(e)));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!cards) return <p>Loading…</p>;
  if (cards.length === 0) return <p>Nothing due — you're all caught up. 🎉</p>;

  return (
    <section>
      <h1>Due ({cards.length})</h1>
      <ul style={{ lineHeight: 1.8 }}>
        {cards.map((c) => (
          <li key={c.url}>
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.title || c.url}
            </a>
            {c.due ? <span style={{ color: "#888" }}> — {c.due}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
