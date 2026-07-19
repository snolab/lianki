import { useEffect, useRef, useState } from "react";
import { joinRoom, roomKey, type SyncSession } from "../lib/webrtcSync";
import { getToken } from "../lib/api";

// Peer-to-peer card sync over WebRTC. Two people entering the same code join the
// same signaling room; each device exports its deck (YAML) over the data channel
// and imports what it receives (merge). The signaling server only brokers the
// handshake — decks flow device-to-device.
async function exportYaml(): Promise<string> {
  const token = getToken();
  const res = await fetch("/api/export/yaml", {
    credentials: "include",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return res.ok ? res.text() : "";
}

async function importYaml(yaml: string): Promise<number> {
  const token = getToken();
  const res = await fetch("/api/import/yaml", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "text/yaml",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: yaml,
  });
  const d = (await res.json().catch(() => ({}))) as { notesUpserted?: number };
  return d.notesUpserted ?? 0;
}

export function SyncPage() {
  const [code, setCode] = useState("");
  const [peers, setPeers] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const sessionRef = useRef<SyncSession | null>(null);
  const say = (m: string) => setLog((l) => [m, ...l].slice(0, 8));

  useEffect(() => {
    const t = getToken();
    if (t) setCode(t.slice(0, 12)); // default room from the token (a shared secret)
  }, []);

  async function start() {
    if (!code.trim() || sessionRef.current) return;
    const key = await roomKey(code.trim());
    say("Joining room…");
    sessionRef.current = joinRoom(key, {
      onPeers: setPeers,
      onOpen: async (peerId, send) => {
        say(`Connected to ${peerId.slice(0, 8)} — sending deck`);
        send(await exportYaml());
      },
      onMessage: async (peerId, data) => {
        const n = await importYaml(data);
        say(`Merged ${n} cards from ${peerId.slice(0, 8)}`);
      },
    });
  }

  function stop() {
    sessionRef.current?.close();
    sessionRef.current = null;
    setPeers(0);
    say("Disconnected.");
  }

  useEffect(() => () => sessionRef.current?.close(), []);

  return (
    <section style={{ maxWidth: 480 }}>
      <h1>Sync (P2P)</h1>
      <p style={{ color: "var(--muted)" }}>
        Enter the same code on another device to sync your deck peer-to-peer over WebRTC.
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input placeholder="sync code" value={code} onChange={(e) => setCode(e.target.value)} />
        {sessionRef.current ? (
          <button onClick={stop}>Stop</button>
        ) : (
          <button onClick={start}>Start syncing</button>
        )}
      </div>
      <p style={{ marginTop: "0.75rem" }}>Peers connected: {peers}</p>
      <ul style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7 }}>
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
