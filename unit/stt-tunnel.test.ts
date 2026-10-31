/**
 * scripts/local-stt/tunnel.sh against stand-ins for oxmgr, cloudflared and
 * curl (shell stubs that keep their state in a temp dir and log every call),
 * so `up` and the rollback `down` are exercised for real without touching the
 * Mac's supervisor, Cloudflare, or the network. The oxmgr stub's `restart`
 * writes what server.py would print, from the config file tunnel.sh wrote.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts/local-stt/tunnel.sh");
const UUID = "11111111-2222-3333-4444-555555555555";
const BASE_CMD =
  "/venv/bin/python -I scripts/local-stt/server.py --port 5193 --tailnet /lianki-stt";

// STUB_PUBLIC=fail: the server cannot bind the tunnel port (it logs that and keeps the tailnet).
// STUB_DEAD=1: the server never says "listening".
const OXMGR = `#!/bin/bash
S="$STUB_STATE/ox"; mkdir -p "$S"; echo "oxmgr $*" >> "$STUB_STATE/log"
case "$1" in
  status) [ -f "$S/$2" ] && cat "$S/$2" || exit 1 ;;
  delete) rm -f "$S/$2" ;;
  restart) [ -f "$S/$2" ] || exit 1
    if [ "$2" = lianki-stt ]; then
      L="$STUB_STATE/server.log"; echo "fake ready" >> "$L"
      [ -n "$STUB_DEAD" ] && exit 0
      if [ -f "$STT_PUBLIC_CONFIG" ]; then
        if [ "$STUB_PUBLIC" = fail ]; then echo "public listener off: cannot listen on 127.0.0.1:5188 (OSError)" >> "$L"
        else echo "public listener on ws://127.0.0.1:5188 (tickets required) $(cat "$STT_PUBLIC_CONFIG")" >> "$L"; fi
      fi
      echo "listening on ws://127.0.0.1:5193" >> "$L"
    fi ;;
  start) shift; name=""; cwd="/"; while [ "$#" -gt 1 ]; do case "$1" in
      --name) name="$2"; shift 2 ;; --cwd) cwd="$2"; shift 2 ;; --restart) shift 2 ;; *) shift ;; esac; done
    printf 'Status:      running\\nCommand:     %s\\nWorking Dir: %s\\n' "$1" "$cwd" > "$S/$name" ;;
esac
`;
const CLOUDFLARED = `#!/bin/bash
echo "cloudflared $*" >> "$STUB_STATE/log"
[ "$1" = tunnel ] || exit 1
case "$2" in
  list) [ -f "$STUB_STATE/tunnel" ] && echo "[{\\"id\\":\\"${UUID}\\",\\"name\\":\\"lianki-stt\\",\\"connections\\":[{\\"id\\":\\"zzz\\"}]}]" || echo "[]" ;;
  create) touch "$STUB_STATE/tunnel"; echo '{"AccountTag":"x"}' > "$CLOUDFLARED_DIR/${UUID}.json" ;;
  delete) rm -f "$STUB_STATE/tunnel" ;;
  route|cleanup) ;;
  *) exit 1 ;;
esac
`;
const CURL = `#!/bin/bash
echo "curl $*" >> "$STUB_STATE/log"
exit "\${STUB_HEALTH:-0}"
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "stt-tunnel-"));
  const state = join(root, "state");
  const cfdDir = join(root, "cloudflared");
  mkdirSync(join(state, "ox"), { recursive: true });
  mkdirSync(cfdDir);
  writeFileSync(join(cfdDir, "cert.pem"), "stub");
  // A custom key path: it must reach the server (through the config file), not the default.
  const pub = join(root, "keys", "custom.pub");
  mkdirSync(join(root, "keys"));
  writeFileSync(pub, "AAAA\n");
  const pubConf = join(root, "config", "public.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [n, body] of [
    ["oxmgr", OXMGR],
    ["cloudflared", CLOUDFLARED],
    ["curl", CURL],
  ]) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
  }
  // The STT server as it runs today (with flags tunnel.sh must never touch).
  const entry =
    `Status:      running\nCommand:     ${BASE_CMD}\nWorking Dir: ${REPO}\n` +
    `Stdout Log:  ${join(state, "server.log")}\n`;
  writeFileSync(join(state, "ox", "lianki-stt"), entry);
  const env = {
    ...process.env,
    STUB_STATE: state,
    OXMGR: join(bin, "oxmgr"),
    CLOUDFLARED: join(bin, "cloudflared"),
    CURL: join(bin, "curl"),
    CLOUDFLARED_DIR: cfdDir,
    STT_TICKET_PUB: pub,
    STT_PUBLIC_CONFIG: pubConf,
    STT_WAIT_S: "3",
    CLOUDFLARE_API_TOKEN: "",
  };
  const sh = (arg: string, extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", SCRIPT, arg], { env: { ...env, ...extra } });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const ox = (name: string) => {
    const f = join(state, "ox", name);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const log = () =>
    existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8") : "";
  const restarts = () => log().match(/oxmgr restart lianki-stt\n/g)?.length ?? 0;
  return { root, state, cfdDir, pub, pubConf, entry, sh, ox, log, restarts };
}

describe("scripts/local-stt/tunnel.sh", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  test("up: the tunnel, its route, the ticket listener and the connector under oxmgr", () => {
    const r = h.sh("up");
    expect(r).toMatchObject({ code: 0 });
    expect(h.log()).toContain("cloudflared tunnel create lianki-stt");
    expect(h.log()).toContain("cloudflared tunnel route dns lianki-stt stt.lianki.com");
    expect(h.ox("lianki-stt-tunnel")).toContain(
      `tunnel --config ${h.cfdDir}/lianki-stt.yml run lianki-stt`,
    );
    const conf = readFileSync(join(h.cfdDir, "lianki-stt.yml"), "utf8");
    expect(conf).toContain("hostname: stt.lianki.com\n    service: http://127.0.0.1:5188");
    expect(conf).toContain("- service: http_status:404");
    // The tunnel credentials and config stay private to this user.
    for (const f of [`${UUID}.json`, "lianki-stt.yml", "cert.pem"])
      expect(statSync(join(h.cfdDir, f)).mode & 0o777).toBe(0o600);
    expect(r.out).toContain("rate limit NOT applied");
  });

  test("up leaves the STT server's oxmgr entry, flags and all, exactly as it was", () => {
    h.sh("up");
    expect(h.ox("lianki-stt")).toBe(h.entry);
    expect(h.log()).not.toContain("oxmgr delete lianki-stt\n");
    expect(h.log()).not.toContain("oxmgr start --name lianki-stt ");
    expect(h.restarts()).toBe(1);
    // Checked after the switch: the tailnet listener's /health.
    expect(h.log()).toContain("curl -fsS --max-time 5 http://127.0.0.1:5193/health");
  });

  test("the key path given (STT_TICKET_PUB) is the one the server is told to use", () => {
    h.sh("up");
    expect(JSON.parse(readFileSync(h.pubConf, "utf8"))).toEqual({ port: 5188, pubkey: h.pub });
    // Written as server.py accepts it: a regular file, 0600 (it refuses group/world-writable).
    expect(statSync(h.pubConf).mode & 0o777).toBe(0o600);
  });

  test("up twice: no second tunnel, no second restart", () => {
    h.sh("up");
    expect(h.sh("up").code).toBe(0);
    expect(h.log().match(/tunnel create/g)).toHaveLength(1);
    expect(h.restarts()).toBe(1);
  });

  test("the tunnel listener failing to start: restored, and no connector is started", () => {
    const r = h.sh("up", { STUB_PUBLIC: "fail" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("cannot listen on 127.0.0.1:5188");
    expect(r.out).toContain("restoring the STT server as it was");
    expect(existsSync(h.pubConf)).toBe(false);
    expect(h.restarts()).toBe(2); // the switch, then the restore
    expect(h.ox("lianki-stt")).toBe(h.entry);
    expect(h.ox("lianki-stt-tunnel")).toBeNull();
  });

  test("the tailnet health check failing after the switch: restored", () => {
    const r = h.sh("up", { STUB_HEALTH: "7" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("restoring the STT server as it was");
    expect(existsSync(h.pubConf)).toBe(false);
    expect(h.ox("lianki-stt-tunnel")).toBeNull();
  });

  test("a server that never says listening: restored (bounded wait)", () => {
    const r = h.sh("up", { STUB_DEAD: "1", STT_WAIT_S: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no 'listening' line");
    expect(existsSync(h.pubConf)).toBe(false);
  });

  test("down after up: everything up made is gone, and the STT server keeps its tailnet route", () => {
    h.sh("up");
    const r = h.sh("down");
    expect(h.ox("lianki-stt-tunnel")).toBeNull();
    expect(h.ox("lianki-stt")).toBe(h.entry);
    expect(existsSync(h.pubConf)).toBe(false);
    expect(h.restarts()).toBe(2);
    expect(r.out).toContain("tunnel listener off (tailnet unchanged)");
    expect(h.log()).toContain("cloudflared tunnel delete -f lianki-stt");
    expect(existsSync(join(h.cfdDir, `${UUID}.json`))).toBe(false);
    expect(existsSync(join(h.cfdDir, "lianki-stt.yml"))).toBe(false);
    // Without an API token the DNS record cannot be removed: said, and the exit code says so.
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT removed");
  });

  test("down with nothing up is harmless", () => {
    const r = h.sh("down");
    expect(r.code).toBe(1); // only the DNS warning
    expect(h.ox("lianki-stt")).toBe(h.entry);
    expect(h.restarts()).toBe(0);
    expect(h.log()).not.toContain("oxmgr start");
    expect(h.log()).not.toContain("tunnel delete");
  });

  test("up refuses without the ticket key or the cloudflared login", () => {
    expect(h.sh("up", { STT_TICKET_PUB: join(h.root, "none") })).toMatchObject({ code: 3 });
    expect(h.sh("up", { CLOUDFLARED_DIR: join(h.root, "empty") })).toMatchObject({ code: 3 });
    expect(h.log()).not.toContain("tunnel create");
    expect(existsSync(h.pubConf)).toBe(false);
  });

  test("DRY_RUN prints the rollback without doing it", () => {
    h.sh("up");
    const r = h.sh("down", { DRY_RUN: "1" });
    expect(r.out).toContain("+ ");
    expect(r.out).toContain("delete lianki-stt-tunnel");
    expect(h.ox("lianki-stt-tunnel")).not.toBeNull();
    expect(existsSync(h.pubConf)).toBe(true);
  });
});
