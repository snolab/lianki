/**
 * scripts/dev/preview-tunnel.sh against stand-ins for oxmgr, cloudflared,
 * curl and the API script (shell stubs logging every call): it refuses to
 * open the tunnel unless the gate already answers 503, runs cloudflared with
 * a token FILE (never the token on a command line), and `down` undoes it all.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/dev/preview-tunnel.sh");
const RUN_TOKEN = "RUN-TOKEN-SECRET";

const OXMGR = `#!/bin/bash
S="$STUB_STATE/ox"; mkdir -p "$S"; echo "oxmgr $*" >> "$STUB_STATE/log"
case "$1" in
  status) [ -f "$S/$2" ] && printf 'Status:      running\\n' || exit 1 ;;
  delete) rm -f "$S/$2" ;;
  restart) [ -f "$S/$2" ] ;;
  start) shift; name=""; while [ "$#" -gt 1 ]; do case "$1" in --name) name="$2"; shift 2 ;; --restart) shift 2 ;; *) shift ;; esac; done
    echo "$1" > "$S/$name" ;;
esac
`;
// The gate's answer is STUB_GATE (default 503).
// STUB_GATE: the status the gate answers (default 503); STUB_NO_MARKER: a 503
// that does not come from the gate (no x-lianki-gate header).
const CURL = `#!/bin/bash
echo "curl $*" >> "$STUB_STATE/log"
case " $* " in
  *" -D - "*) printf 'HTTP/1.1 %s Service Unavailable\\r\\n' "\${STUB_GATE:-503}"
    [ -z "$STUB_NO_MARKER" ] && printf 'x-lianki-gate: 1\\r\\n'
    printf '\\r\\n' ;;
  *) printf '%s' "\${STUB_GATE:-503}" ;;
esac
`;
const API = `#!/bin/bash
echo "api $*" >> "$STUB_STATE/log"
case "$1" in
  up) shift; [ "$1" = --token-out ] && { mkdir -p "$(dirname "$2")"; rm -f "$2"; (umask 077; echo "${RUN_TOKEN}" > "$2"); } ;;
  down) [ -n "$STUB_API_FAIL" ] && exit 1; exit 0 ;;
  check-secret) [ "$(stat -f %Lp "$2" 2>/dev/null || stat -c %a "$2")" = 600 ] ;;
  status) echo "tunnel: stub" ;;
esac
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "preview-tunnel-"));
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  for (const [n, body] of [
    ["oxmgr", OXMGR],
    ["curl", CURL],
    ["api", API],
    ["cloudflared", "#!/bin/bash\nexit 0\n"],
  ]) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
  }
  const token = join(root, "cfg", "preview-tunnel-token");
  const env = {
    ...process.env,
    STUB_STATE: state,
    OXMGR: join(bin, "oxmgr"),
    CURL: join(bin, "curl"),
    CLOUDFLARED: join(bin, "cloudflared"),
    PREVIEW_TUNNEL_API: join(bin, "api"),
    PREVIEW_TUNNEL_TOKEN_FILE: token,
  };
  const sh = (arg: string, extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", SCRIPT, arg], { env: { ...env, ...extra } });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const log = () =>
    existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8") : "";
  const proc = () => {
    const f = join(state, "ox", "lianki-preview-tunnel");
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  return { sh, log, proc, token };
}

describe("scripts/dev/preview-tunnel.sh", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  test("up: API tunnel, token file checked, cloudflared run with --token-file", () => {
    const r = h.sh("up");
    expect(r.code).toBe(0);
    expect(h.log()).toContain(`api up --token-out ${h.token}`);
    expect(h.log()).toContain(`api check-secret ${h.token}`);
    expect(h.proc()).toContain(`tunnel --no-autoupdate run --token-file ${h.token}`);
    // The token itself is never on a command line or in output.
    expect(h.log()).not.toContain(RUN_TOKEN);
    expect(h.proc()).not.toContain(RUN_TOKEN);
    expect(r.out).not.toContain(RUN_TOKEN);
  });

  test("up refuses while the gate does not answer 503 (the tunnel must only ever reach the gate)", () => {
    for (const code of ["000", "200", "403"]) {
      const r = h.sh("up", { STUB_GATE: code });
      expect(r.code).toBe(3);
    }
    expect(h.log()).not.toContain("api up");
    expect(h.proc()).toBeNull();
  });

  test("a 503 that is not the gate's (no marker) is not taken for the gate", () => {
    expect(h.sh("up", { STUB_NO_MARKER: "1" }).code).toBe(3);
    expect(h.log()).toContain(
      "-D - --max-time 5 -H Host: preview.lianki.com http://127.0.0.1:3104/_lk/up",
    );
    expect(h.log()).not.toContain("api up");
    expect(h.proc()).toBeNull();
  });

  test("up checks the gate with the tunnel's Host header", () => {
    h.sh("up");
    expect(h.log()).toContain("-H Host: preview.lianki.com http://127.0.0.1:3104/");
  });

  test("down: connector, tunnel and DNS (API), token file", () => {
    h.sh("up");
    const r = h.sh("down");
    expect(r.code).toBe(0);
    expect(h.proc()).toBeNull();
    expect(h.log()).toContain("api down");
    expect(existsSync(h.token)).toBe(false);
  });

  test("down without the API: says what is left, still removes the token file", () => {
    h.sh("up");
    const r = h.sh("down", { STUB_API_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT removed");
    expect(existsSync(h.token)).toBe(false);
    expect(h.proc()).toBeNull();
  });

  test("down with nothing up is harmless", () => {
    expect(h.sh("down").code).toBe(0);
  });
});
