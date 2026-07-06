import { useRef, useState } from "react";

// Backup / restore. Export streams YAML from /api/export/yaml; import posts a
// YAML file to /api/import/yaml. Both are session-authed on the Worker.
export function DataPage() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function exportYaml() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/export/yaml", { credentials: "include" });
      if (!res.ok) throw new Error(res.status === 401 ? "Please sign in." : `HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lianki-export.yaml";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("Exported.");
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function importYaml(file: File) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/import/yaml", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "text/yaml" },
        body: await file.text(),
      });
      const data = (await res.json().catch(() => ({}))) as {
        notesUpserted?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(`Imported ${data.notesUpserted ?? 0} notes.`);
    } catch (e) {
      setStatus(`Import failed: ${String(e)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section>
      <h1>Data</h1>
      <p>Back up or restore your cards as YAML.</p>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={exportYaml} disabled={busy} style={{ padding: "0.5rem 1rem" }}>
          Export YAML
        </button>
        <label
          style={{
            padding: "0.5rem 1rem",
            border: "1px solid #ccc",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Import YAML…
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,text/yaml"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importYaml(f);
            }}
          />
        </label>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
