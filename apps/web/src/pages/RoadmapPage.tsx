import { useEffect, useState } from "react";
import { api } from "../lib/api";

// Learning roadmaps. Lists goals (GET /api/roadmap); each goal has a topic and
// a set of nodes (milestones).
type RoadmapNode = { title: string };
type Goal = { _id?: string; topic: string; nodes: RoadmapNode[] };

export function RoadmapPage() {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Goal[]>("/api/roadmap")
      .then(setGoals)
      .catch((e: unknown) =>
        setError((e as { status?: number })?.status === 401 ? "Please sign in." : String(e)),
      );
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!goals) return <p>Loading…</p>;
  if (goals.length === 0) return <p>No roadmaps yet.</p>;

  return (
    <section>
      <h1>Roadmaps</h1>
      {goals.map((g) => (
        <details key={g._id ?? g.topic} style={{ marginBottom: "0.75rem" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            {g.topic} <span style={{ color: "#888" }}>({g.nodes?.length ?? 0} nodes)</span>
          </summary>
          <ol style={{ marginTop: "0.5rem" }}>
            {(g.nodes ?? []).map((n, i) => (
              <li key={i}>{n.title}</li>
            ))}
          </ol>
        </details>
      ))}
    </section>
  );
}
