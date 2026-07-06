import { useEffect, useState } from "react";
import { api } from "../lib/api";

// Read materials (paginated). GET /api/read?page=&pageSize=.
type Material = { id?: string; url?: string; title?: string; updatedAt?: string };
type ReadResponse = { materials: Material[]; total: number; page: number; totalPages: number };

export function ReadPage() {
  const [data, setData] = useState<ReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api<ReadResponse>(`/api/read?page=${page}&pageSize=10`)
      .then(setData)
      .catch((e: unknown) =>
        setError((e as { status?: number })?.status === 401 ? "Please sign in." : String(e)),
      );
  }, [page]);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <section>
      <h1>Read materials ({data.total})</h1>
      {data.materials.length === 0 ? (
        <p>Nothing saved yet.</p>
      ) : (
        <ul style={{ lineHeight: 1.8 }}>
          {data.materials.map((m) => (
            <li key={m.id ?? m.url}>
              <a href={m.url} target="_blank" rel="noreferrer">
                {m.title || m.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {data.totalPages > 1 ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span>
            {data.page} / {data.totalPages}
          </span>
          <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      ) : null}
    </section>
  );
}
