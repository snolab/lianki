#!/usr/bin/env bun
export {};
/** Synthetic messages only through the existing authenticated cloud service.
 * No token files, owner history or recordings. Needs inherited LIANKI_TOKEN.
 */
const token = process.env.LIANKI_TOKEN;
if (!token) {
  console.log(JSON.stringify({ status: "blocked", reason: "account-token-not-inherited" }));
  process.exit(2);
}
const base = new URL(process.env.LIANKI_URL ?? "https://lianki.com");
if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
  throw Error("HTTPS required");

const cases = [
  {
    name: "household",
    expected: "ignore",
    message: "宝宝，饭在桌上，去叫妈妈一起吃。",
    context: [],
  },
  {
    name: "instruction",
    expected: "forward",
    message: "Codex，帮我修复按钮点击后没有反应的问题。",
    context: [],
  },
  {
    name: "continuation",
    expected: "forward",
    message: "然后把默认颜色改成蓝色。",
    context: [{ from: "owner", text: "帮我做一个设置按钮。" }],
  },
] as const;
let failures = 0;
for (const c of cases) {
  const start = performance.now();
  let pass = false;
  try {
    const res = await fetch(new URL("/api/version/chat", base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        op: "prepare",
        input: { v: 1, requestId: crypto.randomUUID(), text: c.message, context: c.context },
      }),
    });
    const result = (await res.json()) as {
      ok?: boolean;
      error?: string;
      verdict?: { action?: string; confidence?: string };
    };
    if (!res.ok || !result.ok) {
      console.log(
        JSON.stringify({
          status: "blocked",
          reason:
            res.status === 400 ? "prepare-not-deployed" : (result.error ?? "service-unavailable"),
          ms: Math.round(performance.now() - start),
        }),
      );
      process.exit(2);
    }
    const r = result.verdict ?? {};
    pass = r.action === c.expected && (r.action !== "ignore" || r.confidence === "high");
  } catch {}
  if (!pass) failures++;
  console.log(
    JSON.stringify({
      case: c.name,
      status: pass ? "pass" : "fail",
      ms: Math.round(performance.now() - start),
    }),
  );
}
process.exitCode = failures ? 1 : 0;
