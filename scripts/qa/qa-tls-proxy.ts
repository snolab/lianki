// Local TLS in front of `wrangler dev`, as Cloudflare terminates TLS in production.
// For scripts/qa/qa-host-cookie.mjs. Not for anything but localhost.
// bun scripts/qa/qa-tls-proxy.ts <publicPort> <upstreamPort> <cert> <key>
const [pub, up, cert, key] = process.argv.slice(2);
const PUBLIC = `https://localhost:${pub}`;
const UP = `http://127.0.0.1:${up}`;
Bun.serve({
  port: Number(pub),
  hostname: "localhost",
  idleTimeout: 200,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req) {
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", `localhost:${pub}`);
    const res = await fetch(`${UP}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers(res.headers);
    const loc = out.get("location");
    if (loc?.startsWith(UP)) out.set("location", PUBLIC + loc.slice(UP.length));
    if (loc?.startsWith(`http://localhost:${up}`))
      out.set("location", PUBLIC + loc.slice(`http://localhost:${up}`.length));
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
  },
});
console.log(`tls proxy ${PUBLIC} -> ${UP}`);
