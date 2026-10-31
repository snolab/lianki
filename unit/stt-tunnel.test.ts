/**
 * scripts/local-stt/tunnel.sh against stand-ins for oxmgr and cloudflared
 * (shell stubs that keep their state in a temp dir and log every call), so
 * `up` and the rollback `down` are exercised for real without touching the
 * Mac's supervisor, Cloudflare, or the network.
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

const OXMGR = `#!/bin/bash
S="$STUB_STATE/ox"; mkdir -p "$S"; echo "oxmgr $*" >> "$STUB_STATE/log"
case "$1" in
  status) [ -f "$S/$2" ] && cat "$S/$2" || exit 1 ;;
  delete) rm -f "$S/$2" ;;
  restart) [ -f "$S/$2" ] ;;
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "stt-tunnel-"));
  const state = join(root, "state");
  const cfdDir = join(root, "cloudflared");
  mkdirSync(join(state, "ox"), { recursive: true });
  mkdirSync(cfdDir);
  writeFileSync(join(cfdDir, "cert.pem"), "stub");
  const pub = join(root, "ticket.pub");
  writeFileSync(pub, "AAAA\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [n, body] of [
    ["oxmgr", OXMGR],
    ["cloudflared", CLOUDFLARED],
  ]) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
  }
  // The STT server as it runs today, from a checkout whose server.py knows --public-port.
  writeFileSync(
    join(state, "ox", "lianki-stt"),
    `Status:      running\nCommand:     ${BASE_CMD}\nWorking Dir: ${REPO}\n`,
  );
  const env = {
    ...process.env,
    STUB_STATE: state,
    OXMGR: join(bin, "oxmgr"),
    CLOUDFLARED: join(bin, "cloudflared"),
    CLOUDFLARED_DIR: cfdDir,
    STT_TICKET_PUB: pub,
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
  return { root, state, cfdDir, sh, ox, log };
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
    expect(h.ox("lianki-stt")).toContain(`${BASE_CMD} --public-port 5188`);
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
    // Twice is the same: no second tunnel, no second server restart.
    const again = h.sh("up");
    expect(again.code).toBe(0);
    expect(h.log().match(/tunnel create/g)).toHaveLength(1);
    expect(h.ox("lianki-stt")?.match(/--public-port/g)).toHaveLength(1);
  });

  test("down after up: everything up made is gone, and the STT server keeps its tailnet route", () => {
    h.sh("up");
    const r = h.sh("down");
    expect(h.ox("lianki-stt-tunnel")).toBeNull();
    expect(h.ox("lianki-stt")).toContain(`Command:     ${BASE_CMD}\n`);
    expect(h.ox("lianki-stt")).not.toContain("--public-port");
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
    expect(h.ox("lianki-stt")).toContain(BASE_CMD);
    expect(h.log()).not.toContain("oxmgr start");
    expect(h.log()).not.toContain("tunnel delete");
  });

  test("up refuses without the ticket key or the cloudflared login", () => {
    expect(h.sh("up", { STT_TICKET_PUB: join(h.root, "none") })).toMatchObject({ code: 3 });
    expect(h.sh("up", { CLOUDFLARED_DIR: join(h.root, "empty") })).toMatchObject({ code: 3 });
    expect(h.log()).not.toContain("tunnel create");
  });

  test("DRY_RUN prints the rollback without doing it", () => {
    h.sh("up");
    const r = h.sh("down", { DRY_RUN: "1" });
    expect(r.out).toContain("+ ");
    expect(r.out).toContain("delete lianki-stt-tunnel");
    expect(h.ox("lianki-stt-tunnel")).not.toBeNull();
  });
});
