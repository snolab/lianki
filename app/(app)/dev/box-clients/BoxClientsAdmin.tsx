"use client";

import { useEffect, useState } from "react";

type Box = {
  clientId: string;
  origin: string;
  email: string | null;
  scopes: string[];
  revokedAt: number | null;
};

/** Owner-only and Chinese only, like the other /dev pages. */
export default function BoxClientsAdmin() {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [origin, setOrigin] = useState("");
  const [email, setEmail] = useState("");
  const [write, setWrite] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/api/dev/box-clients")
      .then((r) => r.json())
      .then((d) => setBoxes(d.boxes ?? []))
      .catch(() => setNote("读取失败"));
  }, []);

  async function post(body: Record<string, unknown>) {
    setNote("");
    const r = await fetch("/api/dev/box-clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setNote(d.error ?? "失败");
    setBoxes(d.boxes ?? []);
    if (d.clientId)
      setNote(`client id：${d.clientId}（写进盒子的 env 文件 DEVBOX_LIANKI_CLIENT_ID）`);
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post({
            op: "add",
            origin: origin.trim(),
            email: email.trim(),
            scopes: write ? ["box:read", "box:write"] : ["box:read"],
          });
        }}
      >
        <input
          className="input input-bordered w-full"
          placeholder="https://my-<hash>.lianki.com"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        />
        <input
          className="input input-bordered w-full"
          placeholder="账号邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          允许写入（box:write）
        </label>
        <button className="btn btn-primary btn-sm" type="submit">
          绑定
        </button>
      </form>
      {note && <p className="text-sm break-all">{note}</p>}
      <ul className="space-y-2">
        {boxes.map((b) => (
          <li key={b.clientId} className="text-sm border rounded p-2 break-all">
            <div>{b.origin}</div>
            <div className="opacity-70">
              {b.email ?? "?"} · {b.scopes.join(" ")}
              {b.revokedAt ? " · 已撤销" : ""}
            </div>
            {!b.revokedAt && (
              <button
                className="btn btn-xs mt-1"
                type="button"
                onClick={() => void post({ op: "revoke", clientId: b.clientId })}
              >
                撤销
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
