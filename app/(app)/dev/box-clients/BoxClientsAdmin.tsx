"use client";

import { useEffect, useState } from "react";

type Box = {
  clientId: string;
  origin: string;
  email: string | null;
  scopes: string[];
  revokedAt: number | null;
  /** On the my-box allowlist (or a site owner). A box whose account is not does nothing. */
  allowed?: boolean;
};

type Allowed = { userId: string; email: string | null; name: string | null };

/** What box:chat lets the box do (docs/box-oauth.md, "Chat on the owner's box"). */
const CHAT_WARNING =
  "警告：允许后，这个盒子上的任何脚本都能以你的身份使用 Li 聊天：读聊天记录、发消息、用麦克风转写、点问答卡（包括批准）。只有绑定到站点所有者账号的盒子能开。随时可以关闭，撤销盒子也会关闭。";

/** What box:eval lets the box do (docs/box-oauth.md, "Code on the owner's box"). */
const EVAL_WARNING =
  "警告：允许后，这个盒子上的任何脚本都能通过聊天中枢在你的页面上执行代码：盒子页面会出现配对请求（仍需你在那个页面上点允许），配对后的发送端能在盒子页面上执行代码，页面错误也会发给代理。盒子的依赖、代理在盒子上运行的任何东西都算在内。只有已开聊天、绑定到站点所有者账号的盒子能开。随时可以关闭；关闭聊天或撤销盒子也会关闭它。";

/** Owner-only and Chinese only, like the other /dev pages. */
export default function BoxClientsAdmin() {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [allowed, setAllowed] = useState<Allowed[]>([]);
  const [who, setWho] = useState("");
  const [origin, setOrigin] = useState("");
  const [email, setEmail] = useState("");
  const [write, setWrite] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetch("/api/dev/box-clients")
      .then((r) => r.json())
      .then((d) => {
        setBoxes(d.boxes ?? []);
        setAllowed(d.allowed ?? []);
      })
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
    setAllowed(d.allowed ?? []);
    if (d.clientId)
      setNote(`client id：${d.clientId}（写进盒子的 env 文件 DEVBOX_LIANKI_CLIENT_ID）`);
  }

  return (
    <div className="space-y-4">
      <section className="space-y-2 border rounded p-2" data-box-allowlist>
        <h2 className="font-bold text-sm">盒子名单（my-box，默认不允许）</h2>
        <p className="text-xs opacity-70">
          只有名单上的账号能绑定盒子、用盒子地址和盒子上的聊天；和「自定义前端」是同一个名单。
          站点所有者不用加。移除一个人会立刻撤销他的盒子、停止他的预览。
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (who.trim()) void post({ op: "allow", who: who.trim() });
          }}
        >
          <input
            className="input input-bordered input-sm flex-1"
            placeholder="账号邮箱或用户 id"
            aria-label="账号邮箱或用户 id"
            value={who}
            onChange={(e) => setWho(e.target.value)}
          />
          <button className="btn btn-sm" type="submit">
            加入名单
          </button>
        </form>
        {allowed.length === 0 ? (
          <p className="text-xs opacity-60">名单是空的。</p>
        ) : (
          <ul className="text-sm space-y-1">
            {allowed.map((a) => (
              <li key={a.userId} className="flex items-center justify-between gap-2 break-all">
                <span>
                  {a.email ?? a.userId}
                  {a.name ? ` (${a.name})` : ""}
                </span>
                <button
                  className="btn btn-xs"
                  type="button"
                  data-box-disallow
                  onClick={() => {
                    if (confirm(`移除 ${a.email ?? a.userId}？他的盒子会被撤销，预览会全部停止。`))
                      void post({ op: "disallow", userId: a.userId });
                  }}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
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
              {!b.revokedAt && b.allowed === false ? " · 不在名单上，盒子不能用" : ""}
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
                {b.scopes.includes("box:chat") &&
                  (b.scopes.includes("box:eval") ? (
                    <button
                      className="btn btn-xs"
                      type="button"
                      data-box-eval-off
                      onClick={() => void post({ op: "eval", clientId: b.clientId, on: false })}
                    >
                      关闭盒子上的代码执行
                    </button>
                  ) : (
                    <button
                      className="btn btn-xs btn-error"
                      type="button"
                      data-box-eval-on
                      onClick={() => {
                        if (confirm(EVAL_WARNING))
                          void post({ op: "eval", clientId: b.clientId, on: true });
                      }}
                    >
                      允许盒子上的代码执行（box:eval）
                    </button>
                  ))}
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
            {!b.revokedAt && b.scopes.includes("box:eval") && (
              <p className="text-error mt-1" data-box-eval-warning>
                {EVAL_WARNING}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
