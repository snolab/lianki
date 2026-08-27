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
