"use client";

import { useEffect, useState } from "react";

type Box = {
  clientId: string;
  origin: string;
  email: string | null;
  scopes: string[];
  revokedAt: number | null;
};

/** What box:chat lets the box do (docs/box-oauth.md, "Chat on the owner's box"). */
const CHAT_WARNING =
  "警告：允许后，这个盒子上的任何脚本都能以你的身份使用 Li 聊天：读聊天记录、发消息、用麦克风转写、点问答卡（包括批准）。只有绑定到站点所有者账号的盒子能开。随时可以关闭，撤销盒子也会关闭。";

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
          placeholder="https://my-<hash 或名字>.lianki.com"
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
              <div className="flex flex-wrap gap-2 mt-1">
                {b.scopes.includes("box:chat") ? (
                  <button
                    className="btn btn-xs"
                    type="button"
                    data-box-chat-off
                    onClick={() => void post({ op: "chat", clientId: b.clientId, on: false })}
                  >
                    关闭盒子上的聊天
                  </button>
                ) : (
                  <button
                    className="btn btn-xs btn-warning"
                    type="button"
                    data-box-chat-on
                    onClick={() => {
                      if (confirm(CHAT_WARNING))
                        void post({ op: "chat", clientId: b.clientId, on: true });
                    }}
                  >
                    允许盒子上的聊天（box:chat）
                  </button>
                )}
                <button
                  className="btn btn-xs"
                  type="button"
                  onClick={() => void post({ op: "revoke", clientId: b.clientId })}
                >
                  撤销
                </button>
              </div>
            )}
            {!b.revokedAt && b.scopes.includes("box:chat") && (
              <p className="text-warning mt-1" data-box-chat-warning>
                {CHAT_WARNING}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
