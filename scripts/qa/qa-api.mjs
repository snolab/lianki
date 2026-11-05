// Full authenticated user-flow QA against the local dev server.
// Signs up via dev email+password, then exercises FSRS + roadmap + prefs + export.
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

let cookie = "";
const results = [];
function rec(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}
async function call(method, path, body) {
  // `connection: close` avoids a Node-fetch keep-alive quirk vs the dev server.
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      connection: "close",
      // better-auth rejects writes with a missing/untrusted Origin; browsers
      // send this automatically, so a header-less script must supply it.
      origin: BASE,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    // Only attach a body for non-GET/HEAD requests.
    ...(body != null ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  // Merge any Set-Cookie into our jar by name (don't clobber the whole jar — a
  // GET may refresh only one cookie and we'd otherwise drop the session token).
  const setc =
    res.headers.getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  if (setc.length) {
    const jar = new Map(
      cookie ? cookie.split("; ").map((kv) => [kv.slice(0, kv.indexOf("=")), kv]) : [],
    );
    for (const c of setc) {
      const first = c.split(";")[0];
      const name = first.slice(0, first.indexOf("="));
      const val = first.slice(first.indexOf("=") + 1);
      if (val === "" || /expires=thu, 01 jan 1970/i.test(c)) jar.delete(name);
      else jar.set(name, first);
    }
    cookie = [...jar.values()].join("; ");
  }
  let data = null,
    text = "";
  try {
    text = await res.text();
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
}

const U1 = "https://example.com/qa-one";
const U2 = "https://example.com/qa-two";

// ── AUTH ──
{
  const r = await call("POST", "/api/auth/sign-up/email", {
    email: EMAIL,
    password: PW,
    name: "QA",
  });
  rec("AUTH  sign-up + session cookie", r.status === 200 && !!cookie, `HTTP ${r.status}`);
}
{
  const r = await call("GET", "/api/auth/get-session");
  rec(
    "AUTH  session resolves email",
    r.data?.user?.email === EMAIL,
    r.data?.user?.email ?? "(none)",
  );
}

// ── SECURITY (docs/security-measures.md) ──
// A brand-new sign-up is remembered as a known device (lk_device), so its
// own sign-up sends no login notice.
rec("SEC   sign-up sets the lk_device cookie", cookie.includes("lk_device="), "");
// Admin surfaces answer 404 to a signed-in user who is not the owner.
for (const [method, path] of [
  ["GET", "/api/dev/whoami"],
  ["GET", "/api/dev/friends"],
  ["GET", "/api/dev/state-tree"],
  ["GET", "/api/dev/gift-codes"],
  ["POST", "/api/dev/gift-codes"],
  ["POST", "/api/dev/membership"],
  ["GET", "/api/dev/credits?email=x@y.z"],
  ["POST", "/api/dev/credits"],
  ["GET", "/dev/credits"],
  ["GET", "/api/dev/flags"],
  ["POST", "/api/dev/flags"],
  ["GET", "/dev/flags"],
  ["POST", "/api/dev/stt-ticket"],
  ["GET", "/api/dev/dev-tokens"],
  ["POST", "/api/dev/dev-tokens"],
  ["POST", "/api/dev/dev-handoff"],
  ["GET", "/dev/tokens"],
  ["GET", "/dev/preview?to=%2Fen%2Fread"],
  ["GET", "/dev/users"],
  ["GET", "/dev/gift-codes"],
]) {
  const r = await call(method, path, method === "POST" ? {} : undefined);
  rec(`SEC   non-owner ${method} ${path} → 404`, r.status === 404, `HTTP ${r.status}`);
}
// The dev server's token check answers only its gate (the dev bridge secret).
{
  const r = await call("POST", "/api/dev-access/verify", { token: "lkdev_x" });
  rec(
    "SEC   /api/dev-access/verify without the bridge → 401",
    r.status === 401,
    `HTTP ${r.status}`,
  );
}
// Live view (docs/live-view.md): the pointer is the owner's only, and only the
// dev key can write it — an unsigned or foreign-signed one is refused.
for (const method of ["GET", "DELETE"]) {
  const r = await call(method, "/api/live-view");
  rec(`SEC   non-owner ${method} /api/live-view → 404`, r.status === 404, `HTTP ${r.status}`);
}
{
  const r = await call("POST", "/api/live-view", { token: "not-a-signed-pointer" });
  rec("SEC   malformed live-view pointer → 400", r.status === 400, `HTTP ${r.status}`);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const b64 = (b) => Buffer.from(b).toString("base64url");
  const t = Math.floor(Date.now() / 1000);
  const body = b64(
    JSON.stringify({
      aud: "lianki-live-view",
      op: "on",
      serial: Date.now(),
      iat: t,
      exp: t + 600,
      widget: "https://evil.example-tailnet.ts.net/debug-chat.js",
      branch: "qa",
      sha: "abcdef0",
    }),
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, Buffer.from(body));
  const w = await call("POST", "/api/live-view", { token: `${body}.${b64(sig)}` });
  rec("SEC   live-view pointer signed by another key → 401", w.status === 401, `HTTP ${w.status}`);
}
// The same-origin live preview (lib/live-view/page-proxy.ts, in worker.ts): a
// non-owner's ?live=<id> or a forged live cookie gets the normal build, never
// a dev page, never the live cookie.
for (const [path, cookie] of [
  ["/en?live=1793000000000", ""],
  ["/en?live=on", ""],
  ["/en?live=off", ""],
  ["/en", `__Host-lk_live=1793000000000.9999999999999.${"A".repeat(43)}`],
  // A custom frontend's id (docs/custom-frontend.md): its registrant only.
  ["/en?live=AAAAAAAAAAAAAAAAAAAAAA", ""],
  [
    "/en",
    `__Host-lk_live=c.${"A".repeat(22)}.u.9999999999999.0.${"A".repeat(22)}.${"A".repeat(43)}`,
  ],
]) {
  const r = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: { accept: "text/html", "sec-fetch-dest": "document", ...(cookie ? { cookie } : {}) },
  });
  const live = r.headers.get("x-lk-live");
  const setLive = (r.headers.getSetCookie?.() ?? []).some((c) => /^__Host-lk_live=[^;]/.test(c));
  rec(
    `SEC   non-owner ${path}${cookie ? " + forged live cookie" : ""} → normal build`,
    r.status < 300 && !live && !setLive,
    `HTTP ${r.status}${live ? " x-lk-live" : ""}${setLive ? " set live cookie" : ""}`,
  );
}
// While a custom frontend's live cookie is set, its JS cannot mint tokens or
// change the account (customFrontendBlocked in lib/live-view/page-proxy.ts).
// The Worker decides it, so only against a deployed Worker (not next dev).
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
  const r = await fetch(`${BASE}/api/token`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      cookie: `__Host-lk_live=c.${"A".repeat(22)}.u.9999999999999.0.${"A".repeat(22)}.${"A".repeat(43)}`,
    },
    body: "{}",
  });
  rec(
    "SEC   POST /api/token under a custom live cookie → 403",
    r.status === 403,
    `HTTP ${r.status}`,
  );
}
// Uploads: only the one format each import reads.
for (const [name, bytes, label] of [
  ["notes.txt", "hello", "a .txt"],
  ["deck.apkg", "not a zip", "an .apkg that is not a zip"],
]) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const res = await fetch(`${BASE}/api/import/anki`, {
    method: "POST",
    headers: { cookie, origin: BASE, connection: "close" },
    body: form,
  });
  rec(`SEC   anki import refuses ${label}`, res.status === 400, `HTTP ${res.status}`);
}

// ── PROFILE EDITS (docs/secrets-and-auth.md, "Profile edits") ──
{
  const r = await call("POST", "/api/profile/name", { name: "  QA Renamed  " });
  const back = await call("GET", "/api/auth/get-session");
  rec(
    "PROFILE name saved, trimmed",
    r.status === 200 && back.data?.user?.name === "QA Renamed",
    `HTTP ${r.status}`,
  );
  const empty = await call("POST", "/api/profile/name", { name: "   " });
  rec("PROFILE empty name refused", empty.status === 400, `HTTP ${empty.status}`);
  // better-auth's own endpoint would store any image URL: closed over HTTP.
  const direct = await call("POST", "/api/auth/update-user", {
    image: "https://evil.example/x.png",
  });
  rec("PROFILE /update-user closed over HTTP", direct.status === 404, `HTTP ${direct.status}`);

  const upload = (bytes, type = "image/png") =>
    fetch(`${BASE}/api/profile/avatar`, {
      method: "POST",
      headers: { connection: "close", origin: BASE, cookie, "content-type": type },
      body: bytes,
    });
  const svg = await upload(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  rec("PROFILE an SVG named as a PNG refused", svg.status === 415, `HTTP ${svg.status}`);
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const up = await upload(png);
  const { image } = await up.json();
  rec("PROFILE avatar uploaded", up.status === 201 && image.startsWith("/api/avatar/"), image);
  const served = await fetch(`${BASE}${image}`, { headers: { connection: "close" } });
  await served.arrayBuffer();
  rec(
    "PROFILE avatar served, no session, safe headers",
    served.status === 200 &&
      served.headers.get("content-type") === "image/png" &&
      served.headers.get("x-content-type-options") === "nosniff",
    `HTTP ${served.status}`,
  );
  const seen = await call("GET", "/api/auth/get-session");
  rec("PROFILE user.image is the upload", seen.data?.user?.image === image, "");
  const del = await call("DELETE", "/api/profile/avatar", {});
  const gone = await fetch(`${BASE}${image}`, { headers: { connection: "close" } });
  await gone.arrayBuffer();
  rec(
    "PROFILE avatar removed, object gone",
    del.status === 200 && del.data?.image === null && gone.status === 404,
    `HTTP ${del.status}/${gone.status}`,
  );
}

// ── CREATE ──
{
  const r = await call("POST", "/api/fsrs/add", { url: U1, title: "QA One" });
  rec(
    "CREATE add note",
    r.status === 200 && r.data?.url === U1 && r.data?.card?.reps === 0,
    `HTTP ${r.status}`,
  );
  rec(
    "CREATE returns 4 options",
    Array.isArray(r.data?.options) && r.data.options.length === 4,
    (r.data?.options ?? []).map((o) => o.label).join(","),
  );
}
{
  const r = await call("POST", "/api/fsrs/add", { url: U1, title: "QA One" });
  rec("CREATE idempotent same url", r.status === 200, `HTTP ${r.status}`);
}
{
  const r = await call("POST", "/api/fsrs/batch-add", {
    urls: [U2, "https://example.com/qa-three"],
  });
  rec(
    "CREATE batch-add",
    r.status === 200 && r.data?.count === 2,
    `count=${r.data?.count} failed=${r.data?.failed}`,
  );
}

// ── READ ──
{
  const r = await call("GET", `/api/fsrs/options?url=${encodeURIComponent(U1)}`);
  rec(
    "READ options for note",
    r.status === 200 && r.data?.options?.length === 4 && !!r.data?.id,
    `id=${r.data?.id}`,
  );
}
{
  const r = await call("GET", "/api/fsrs/due?limit=50");
  rec(
    "READ due list",
    r.status === 200 && Array.isArray(r.data?.cards),
    `cards=${r.data?.cards?.length}`,
  );
}
{
  const r = await call("GET", "/api/fsrs/next-url");
  rec("READ next-url", r.status === 200, `url=${r.data?.url ?? "(none due)"}`);
}

// ── UPDATE: review all 4 ratings on U2 (re-add between to keep it reviewable) ──
for (const rating of ["again", "hard", "good", "easy"]) {
  await call("POST", "/api/fsrs/add", { url: U2, title: "QA Two" });
  const r = await call("POST", `/api/fsrs/review/${rating}?url=${encodeURIComponent(U2)}`);
  rec(
    `UPDATE review/${rating}`,
    r.status === 200 && r.data?.ok === true,
    `HTTP ${r.status} hlc=${r.data?.hlc?.timestamp ?? "?"}`,
  );
}
{
  const r = await call("PATCH", `/api/fsrs/notes?url=${encodeURIComponent(U1)}`, {
    notes: "study notes",
  });
  rec("UPDATE notes patch", r.status === 200 && r.data?.ok === true, `HTTP ${r.status}`);
}
{
  const NEW = "https://example.com/qa-renamed";
  const r = await call("PATCH", "/api/fsrs/update-url", { oldUrl: U1, newUrl: NEW });
  rec("UPDATE rename url", r.status === 200 && r.data?.ok === true, `HTTP ${r.status}`);
}
{
  // Handler contract: body { url, markers: Record<number, number> }.
  const r = await call("POST", "/api/fsrs/speed-markers", { url: U2, markers: { 1: 1.5 } });
  rec("UPDATE speed-markers", r.status === 200 && r.data?.ok === true, `HTTP ${r.status}`);
  const g = await call("GET", `/api/fsrs/speed-markers?url=${encodeURIComponent(U2)}`);
  rec("READ speed-markers", g.status === 200 && g.data?.markers?.["1"] === 1.5, `HTTP ${g.status}`);
}

// ── HLC conflict (stale → 409) ──
{
  await call("POST", "/api/fsrs/add", { url: U2, title: "QA Two" });
  await call("POST", `/api/fsrs/review/good?url=${encodeURIComponent(U2)}`); // advance server HLC
  const stale = { timestamp: 1000, counter: 0, deviceId: "old" };
  const r = await call("POST", `/api/fsrs/review/good?url=${encodeURIComponent(U2)}`, {
    hlc: stale,
  });
  rec(
    "CONFLICT stale HLC -> 409",
    r.status === 409 && r.data?.error === "conflict",
    `HTTP ${r.status}`,
  );
}

// ── ROADMAP (Phase 2a progress code path) ──
let goalId;
{
  const nodes = [
    {
      id: "n1",
      title: "Basics",
      description: "fundamentals",
      keywords: ["qa", "example"],
      order: 0,
    },
    { id: "n2", title: "Advanced", description: "deeper", keywords: ["renamed"], order: 1 },
  ];
  const r = await call("POST", "/api/roadmap", { topic: "QA Topic", nodes });
  goalId = r.data?._id ?? r.data?.id;
  rec("ROADMAP save goal", r.status === 200 && !!goalId, `id=${goalId}`);
}
{
  const r = await call("GET", "/api/roadmap");
  rec(
    "ROADMAP list goals",
    r.status === 200 && Array.isArray(r.data) && r.data.length >= 1,
    `n=${r.data?.length}`,
  );
}
{
  const r = await call("GET", `/api/roadmap/${goalId}/progress`);
  const ok =
    r.status === 200 &&
    Array.isArray(r.data?.nodes) &&
    typeof r.data?.overallMaturityRate === "number";
  const total = r.data?.nodes?.reduce?.((s, n) => s + n.totalCards, 0);
  rec(
    "ROADMAP progress (Phase 2a)",
    ok,
    `HTTP ${r.status} nodes=${r.data?.nodes?.length} matRate=${r.data?.overallMaturityRate} totalCards=${total}`,
  );
}
{
  const r = await call("GET", `/api/roadmap/000000000000000000000000/progress`);
  rec("ROADMAP progress 404 for missing id", r.status === 404, `HTTP ${r.status}`);
}
{
  // Mongo rejects a malformed ObjectId with 400; on D1 ids are UUIDs, so an
  // unparseable id is simply an unknown id → 404. Both are correct "can't
  // resolve this id" responses, so accept either across backends.
  const r = await call("GET", `/api/roadmap/not-a-valid-id/progress`);
  rec(
    "ROADMAP progress 400/404 for bad id",
    r.status === 400 || r.status === 404,
    `HTTP ${r.status}`,
  );
}

// ── PREFERENCES ──
{
  const r = await call("POST", "/api/preferences", {
    mobileExcludePatterns: [{ type: "domain", value: "x.com" }],
  });
  rec("PREFS save", r.status === 200, `HTTP ${r.status}`);
}
{
  const r = await call("GET", "/api/preferences");
  rec(
    "PREFS read back",
    r.status === 200 && Array.isArray(r.data?.mobileExcludePatterns),
    `n=${r.data?.mobileExcludePatterns?.length}`,
  );
}

// ── EXPORT ──
{
  const res = await fetch(`${BASE}/api/export/yaml`, { headers: { cookie, connection: "close" } });
  const text = await res.text();
  rec(
    "EXPORT yaml",
    res.status === 200 && text.length > 0,
    `HTTP ${res.status} bytes=${text.length}`,
  );
}

// ── TOKEN ──
{
  const r = await call("POST", "/api/token", { name: "qa-token" });
  rec("TOKEN mint", r.status === 200 || r.status === 201, `HTTP ${r.status}`);
  const list = await call("GET", "/api/token");
  rec("TOKEN list", list.status === 200, `HTTP ${list.status}`);
}

// ── DATA MANAGEMENT (/data) ──
{
  const r = await call("GET", "/api/fsrs/stats");
  rec(
    "DATA  stats reports backend + counts",
    r.status === 200 &&
      ["mongo", "d1"].includes(r.data?.backend) &&
      typeof r.data?.notes === "number" &&
      typeof r.data?.due === "number",
    `HTTP ${r.status} backend=${r.data?.backend} notes=${r.data?.notes}`,
  );
}
{
  const r = await call("GET", "/api/fsrs/list?size=10");
  rec(
    "DATA  list returns rows + total",
    r.status === 200 && Array.isArray(r.data?.rows) && typeof r.data?.total === "number",
    `HTTP ${r.status} total=${r.data?.total}`,
  );
}
{
  // U1 was renamed to .../qa-renamed by the UPDATE section above.
  const r = await call("GET", `/api/fsrs/list?q=${encodeURIComponent("qa-renamed")}`);
  rec(
    "DATA  list search narrows to one note",
    r.status === 200 && r.data?.total === 1 && r.data.rows[0]?.url.endsWith("/qa-renamed"),
    `HTTP ${r.status} total=${r.data?.total}`,
  );
}
{
  const r = await call("GET", "/api/fsrs/list?state=0");
  const allNew = (r.data?.rows ?? []).every((row) => row.state === 0);
  rec(
    "DATA  list filters by card state",
    r.status === 200 && allNew,
    `HTTP ${r.status} n=${r.data?.rows?.length}`,
  );
}
{
  // A bare wildcard must be matched literally, not expanded — otherwise the
  // search box silently stops filtering.
  const r = await call("GET", "/api/fsrs/list?q=%25");
  rec(
    "DATA  list treats % as literal",
    r.status === 200 && r.data?.total === 0,
    `HTTP ${r.status}`,
  );
}
{
  // The real Worker entry (worker.ts): a sibling *.lianki.com page's request
  // carries the session cookie, and is refused before any route runs.
  const sibling = await fetch(`${BASE}/api/fsrs/stats`, {
    headers: { connection: "close", cookie, "sec-fetch-site": "same-site" },
  });
  rec(
    "SIBLING  a sibling host's request to /api is refused",
    sibling.status === 403,
    `HTTP ${sibling.status}`,
  );
  const own = await fetch(`${BASE}/api/fsrs/stats`, {
    headers: { connection: "close", cookie, "sec-fetch-site": "same-origin" },
  });
  rec(
    "SIBLING  the same request from lianki.com itself still works",
    own.status === 200,
    `HTTP ${own.status}`,
  );
}
{
  const push = "https://example.com/qa-pushed";
  const r = await call("POST", "/api/fsrs/bulk-upsert", {
    notes: [
      {
        url: push,
        title: "QA pushed",
        card: {
          due: new Date(Date.now() + 86400000).toISOString(),
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        },
        log: [],
        hlc: { timestamp: Date.now(), counter: 0, deviceId: "qa" },
      },
    ],
  });
  rec(
    "DATA  bulk-upsert inserts a new note",
    r.status === 200 && r.data?.upserted === 1,
    `HTTP ${r.status}`,
  );

  const again = await call("GET", `/api/fsrs/list?q=${encodeURIComponent("qa-pushed")}`);
  rec("DATA  pushed note is listed", again.data?.total === 1, `total=${again.data?.total}`);

  // Replaying the same push must be a no-op, not a rewrite.
  const replay = await call("POST", "/api/fsrs/bulk-upsert", {
    notes: [
      {
        url: push,
        title: "QA pushed (stale)",
        card: {
          due: new Date().toISOString(),
          stability: 0,
          difficulty: 0,
          elapsed_days: 0,
          scheduled_days: 0,
          reps: 0,
          lapses: 0,
          state: 0,
        },
        log: [],
        hlc: { timestamp: 1, counter: 0, deviceId: "qa" },
      },
    ],
  });
  rec(
    "DATA  bulk-upsert skips an older clock",
    replay.status === 200 && replay.data?.upserted === 0 && replay.data?.conflicts === 1,
    `upserted=${replay.data?.upserted} conflicts=${replay.data?.conflicts}`,
  );

  const del = await call("POST", "/api/fsrs/bulk-delete", { urls: [push] });
  rec(
    "DATA  bulk-delete removes it",
    del.status === 200 && del.data?.deleted === 1,
    `HTTP ${del.status}`,
  );
}
{
  const r = await call("POST", "/api/fsrs/bulk-delete", { all: true });
  rec("DATA  bulk-delete all without confirm -> 400", r.status === 400, `HTTP ${r.status}`);
}
{
  const r = await call("POST", "/api/fsrs/bulk-delete", {});
  rec("DATA  bulk-delete with no target -> 400", r.status === 400, `HTTP ${r.status}`);
}
{
  const saved = cookie;
  cookie = "";
  const list = await call("GET", "/api/fsrs/list");
  const wipe = await call("POST", "/api/fsrs/bulk-delete", { all: true, confirm: "DELETE" });
  cookie = saved;
  rec("DATA  unauth list -> 401", list.status === 401, `HTTP ${list.status}`);
  rec("DATA  unauth bulk-delete all -> 401", wipe.status === 401, `HTTP ${wipe.status}`);
}

// ── DELETE ──
{
  const r = await call("GET", `/api/fsrs/delete?url=${encodeURIComponent(U2)}`);
  rec(
    "DELETE note",
    r.status === 200 && r.data?.ok === true,
    `HTTP ${r.status} next=${r.data?.nextUrl ?? "-"}`,
  );
}

// ── CREDITS (docs/payments.md, "Credits") — local D1, no provider secrets ──
{
  const w = await call("GET", "/api/payments/credits");
  rec(
    "CREDITS new wallet is empty",
    w.status === 200 && w.data?.balance === 0 && w.data?.entries?.length === 0,
    `HTTP ${w.status} balance=${w.data?.balance}`,
  );
  rec(
    "CREDITS quick amounts line up with the passes",
    JSON.stringify(w.data?.topup?.quick) === "[600,1200,3000,5000]" &&
      w.data?.topup?.min === 100 &&
      w.data?.topup?.max === 10000,
    JSON.stringify(w.data?.topup ?? null),
  );
  rec(
    "CREDITS only enabled providers are listed",
    Array.isArray(w.data?.topup?.providers) &&
      w.data.topup.providers.every((p) => p.id && p.label && !("envKeys" in p)),
    JSON.stringify(w.data?.topup?.providers ?? null),
  );

  const short = await call("POST", "/api/payments/buy-pass", {
    passId: "pro-1m",
    key: crypto.randomUUID(),
  });
  rec(
    "CREDITS buy-pass with no balance -> 402 + missing",
    short.status === 402 && short.data?.missing === 600 && short.data?.price === 600,
    `HTTP ${short.status} missing=${short.data?.missing}`,
  );
  const bad = await call("POST", "/api/payments/buy-pass", { passId: "pro-forever" });
  rec("CREDITS buy-pass unknown pass -> 400", bad.status === 400, `HTTP ${bad.status}`);

  for (const amount of [99, 10001, 600.5, "abc"]) {
    const r = await call("POST", "/api/payments/topup", { amount });
    rec(`CREDITS topup ${JSON.stringify(amount)} -> 400`, r.status === 400, `HTTP ${r.status}`);
  }
  // A valid amount: 503 with no provider secrets set (the qa:all default),
  // otherwise a provider answer — never a credit without a payment.
  const ok = await call("POST", "/api/payments/topup", { amount: 600 });
  rec(
    "CREDITS topup 600 -> 503 (no provider) or a checkout",
    ok.status === 503 || (ok.status === 200 && ok.data?.kind),
    `HTTP ${ok.status}`,
  );
  const after = await call("GET", "/api/payments/credits");
  rec(
    "CREDITS balance unchanged by refused calls",
    after.data?.balance === 0,
    `${after.data?.balance}`,
  );

  const hook = await call("POST", "/api/payments/webhook/komoju", {});
  rec("CREDITS webhook for a disabled provider -> 503", hook.status === 503, `HTTP ${hook.status}`);
  const nohook = await call("POST", "/api/payments/webhook/nope", {});
  rec(
    "CREDITS webhook for an unknown provider -> 404",
    nohook.status === 404,
    `HTTP ${nohook.status}`,
  );

  const saved = cookie;
  cookie = "";
  const u1 = await call("GET", "/api/payments/credits");
  const u2 = await call("POST", "/api/payments/buy-pass", { passId: "pro-1m" });
  const u3 = await call("POST", "/api/payments/topup", { amount: 600 });
  cookie = saved;
  rec(
    "CREDITS unauth credits/buy-pass/topup -> 401",
    u1.status === 401 && u2.status === 401 && u3.status === 401,
    `HTTP ${u1.status}/${u2.status}/${u3.status}`,
  );
}

// ── AUTH guard sanity (no cookie -> 401) ──
{
  const saved = cookie;
  cookie = "";
  const r = await call("GET", "/api/fsrs/due");
  cookie = saved;
  rec("GUARD unauth -> 401", r.status === 401, `HTTP ${r.status}`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} checks passed ===`);
if (pass !== results.length) {
  console.log("FAILURES:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name} — ${r.detail}`);
  process.exit(1);
}
