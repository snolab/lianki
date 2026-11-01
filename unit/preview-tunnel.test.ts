/**
 * scripts/dev/preview-tunnel.sh against stand-ins for oxmgr, cloudflared,
 * curl and the API script (shell stubs logging every call): it refuses to
 * open the tunnel unless the gate already answers 503, runs cloudflared with
 * a token FILE (never the token on a command line), falls back to cert.pem
 * when there is no API token, and `down` undoes it all. The secret-file
 * check is the real one (scripts/ops/cf-tunnel.ts check-secret), so the
 * test runs the same on macOS and Linux (no `stat` flags involved).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/dev/preview-tunnel.sh");
const CF_TUNNEL = resolve(import.meta.dir, "../scripts/ops/cf-tunnel.ts");
const RUN_TOKEN = "RUN-TOKEN-SECRET";
const UUID = "22222222-3333-4444-5555-666666666666";

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
  check-secret|check-owned|check-dir) exec bun "${CF_TUNNEL}" "$1" "$2" ;;
  status) echo "tunnel: stub" ;;
esac
`;
// A cloudflared that keeps one tunnel's state, for the cert.pem path.
const CLOUDFLARED = `#!/bin/bash
echo "cloudflared $*" >> "$STUB_STATE/log"
[ "$1" = tunnel ] || exit 0
case "$2" in
  list) [ -f "$STUB_STATE/tunnel" ] && echo '[{"id":"${UUID}","name":"lianki-preview"}]' || echo '[]' ;;
  create) touch "$STUB_STATE/tunnel"; echo '{"AccountTag":"x"}' > "$CLOUDFLARED_DIR/${UUID}.json"; chmod 644 "$CLOUDFLARED_DIR/${UUID}.json" ;;
  delete) rm -f "$STUB_STATE/tunnel" ;;
  route) [ -n "$STUB_PLANT" ] && { rm -f "$CLOUDFLARED_DIR/lianki-preview.yml"; ln -s "$STUB_PLANT" "$CLOUDFLARED_DIR/lianki-preview.yml"; }; exit 0 ;;
  cleanup) ;;
esac
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "preview-tunnel-"));
  const state = join(root, "state");
  const bin = join(root, "bin");
  const cfd = join(root, "cloudflared");
  mkdirSync(state);
  mkdirSync(bin);
  mkdirSync(cfd);
  for (const [n, body] of [
    ["oxmgr", OXMGR],
    ["curl", CURL],
    ["api", API],
    ["cloudflared", CLOUDFLARED],
  ]) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
  }
  const token = join(root, "cfg", "preview-tunnel-token");
  const apiToken = join(root, "cfg", "cf-api-token");
  mkdirSync(join(root, "cfg"));
  writeFileSync(apiToken, "api-token\n", { mode: 0o600 });
  const env = {
    ...process.env,
    STUB_STATE: state,
    OXMGR: join(bin, "oxmgr"),
    CURL: join(bin, "curl"),
    CLOUDFLARED: join(bin, "cloudflared"),
    CLOUDFLARED_DIR: cfd,
    PREVIEW_TUNNEL_API: join(bin, "api"),
    PREVIEW_TUNNEL_TOKEN_FILE: token,
    CF_API_TOKEN_FILE: apiToken,
    CLOUDFLARE_API_TOKEN: "",
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
  /** cert.pem mode: no API token, a cloudflared login. */
  const certMode = () => {
    writeFileSync(join(cfd, "cert.pem"), "cert", { mode: 0o644 });
    return { CF_API_TOKEN_FILE: join(root, "cfg", "none") };
  };
  return { sh, log, proc, token, cfd, certMode, root };
}

describe("scripts/dev/preview-tunnel.sh (API token)", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  test("up: API tunnel, token file checked, cloudflared run with --token-file", () => {
    const r = h.sh("up");
    expect({ code: r.code, out: r.code ? r.out : "" }).toEqual({ code: 0, out: "" });
    expect(h.log()).toContain(`api up --token-out ${h.token}`);
    expect(h.log()).toContain(`api check-secret ${h.token}`);
    expect(h.proc()).toContain(`tunnel --no-autoupdate run --token-file ${h.token}`);
    // The token itself is never on a command line or in output.
    expect(h.log()).not.toContain(RUN_TOKEN);
    expect(h.proc()).not.toContain(RUN_TOKEN);
    expect(r.out).not.toContain(RUN_TOKEN);
  });

  test("a run-token file that is not 0600 is refused (the real check, no stat flags)", () => {
    // An API stand-in that writes the token readable by others.
    const loose = join(h.root, "bin", "api-loose");
    writeFileSync(
      loose,
      `#!/bin/bash\ncase "$1" in up) echo x > "$3"; chmod 644 "$3" ;; check-secret) exec bun "${CF_TUNNEL}" check-secret "$2" ;; esac\n`,
    );
    chmodSync(loose, 0o755);
    const r = h.sh("up", { PREVIEW_TUNNEL_API: loose });
    expect(r.code).toBe(1);
    expect(r.out).toContain("readable or writable by group or others");
    expect(h.proc()).toBeNull();
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

  test("down when the API call fails: says what is left, still removes the token file", () => {
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

  test("neither an API token nor cert.pem: up says what to do", () => {
    const r = h.sh("up", { CF_API_TOKEN_FILE: join(h.root, "cfg", "none") });
    expect(r.code).toBe(3);
    expect(r.out).toContain("cloudflared tunnel login");
  });
});

describe("scripts/dev/preview-tunnel.sh (cert.pem fallback)", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  test("up: creates the tunnel, ingress to the gate only, DNS route, connector with --config", () => {
    const env = h.certMode();
    const r = h.sh("up", env);
    expect({ code: r.code, out: r.code ? r.out : "" }).toEqual({ code: 0, out: "" });
    expect(h.log()).toContain("cloudflared tunnel create lianki-preview");
    expect(h.log()).toContain("cloudflared tunnel route dns lianki-preview preview.lianki.com");
    expect(h.log()).not.toContain("api up");
    const conf = readFileSync(join(h.cfd, "lianki-preview.yml"), "utf8");
    expect(conf).toContain("hostname: preview.lianki.com\n    service: http://127.0.0.1:3104");
    expect(conf).toContain("- service: http_status:404");
    expect(h.proc()).toContain(`--config ${h.cfd}/lianki-preview.yml run lianki-preview`);
    // cert, credentials and config: owner-only.
    for (const f of ["cert.pem", `${UUID}.json`, "lianki-preview.yml"])
      expect([f, statSync(join(h.cfd, f)).mode & 0o777]).toEqual([f, 0o600]);
    expect(r.out).toContain("rate-limit rule NOT applied");
  });

  test("up twice reuses the tunnel", () => {
    const env = h.certMode();
    h.sh("up", env);
    expect(h.sh("up", env).code).toBe(0);
    expect(h.log().match(/tunnel create/g)).toHaveLength(1);
  });

  test("still refuses while the gate does not answer", () => {
    const env = h.certMode();
    expect(h.sh("up", { ...env, STUB_GATE: "000" }).code).toBe(3);
    expect(h.log()).not.toContain("tunnel create");
  });

  test("down: connector, tunnel, local credentials and config; says the DNS record is left", () => {
    const env = h.certMode();
    h.sh("up", env);
    const r = h.sh("down", env);
    expect(r.code).toBe(1);
    expect(h.proc()).toBeNull();
    expect(h.log()).toContain("cloudflared tunnel delete -f lianki-preview");
    expect(existsSync(join(h.cfd, `${UUID}.json`))).toBe(false);
    expect(existsSync(join(h.cfd, "lianki-preview.yml"))).toBe(false);
    expect(r.out).toContain("DNS record preview.lianki.com NOT removed");
  });

  test("a symlinked cert.pem is refused, and its target's mode is never touched", () => {
    const env = h.certMode();
    const target = join(h.root, "elsewhere.pem");
    writeFileSync(target, "x", { mode: 0o644 });
    rmSync(join(h.cfd, "cert.pem"));
    symlinkSync(target, join(h.cfd, "cert.pem"));
    const r = h.sh("up", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is a symlink");
    expect(statSync(target).mode & 0o777).toBe(0o644); // chmod never followed the link
    expect(h.log()).not.toContain("tunnel create");
    expect(h.proc()).toBeNull();
  });

  test("a symlinked credentials file is refused before any chmod", () => {
    const env = h.certMode();
    const target = join(h.root, "elsewhere.json");
    writeFileSync(target, "{}", { mode: 0o644 });
    writeFileSync(join(h.root, "state", "tunnel"), ""); // the tunnel exists already
    symlinkSync(target, join(h.cfd, `${UUID}.json`));
    const r = h.sh("up", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is a symlink");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(h.proc()).toBeNull();
  });

  test("a symlinked config left at the name is replaced, never written through", () => {
    const env = h.certMode();
    const target = join(h.root, "victim.txt");
    writeFileSync(target, "untouched", { mode: 0o644 });
    symlinkSync(target, join(h.cfd, "lianki-preview.yml"));
    const r = h.sh("up", env);
    expect({ code: r.code, out: r.code ? r.out : "" }).toEqual({ code: 0, out: "" });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    const conf = join(h.cfd, "lianki-preview.yml");
    expect(lstatSync(conf).isSymbolicLink()).toBe(false);
    expect(statSync(conf).mode & 0o777).toBe(0o600);
    // No temp files left behind.
    expect(readdirSync(h.cfd).filter((f) => f.startsWith(".lianki-preview.yml."))).toEqual([]);
  });

  test("a config swapped in after it was written (a race) stops the start", () => {
    const env = h.certMode();
    const planted = join(h.root, "planted.yml");
    writeFileSync(planted, "ingress:\n  - service: http://127.0.0.1:22\n", { mode: 0o600 });
    const r = h.sh("up", { ...env, STUB_PLANT: planted });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to start");
    expect(h.proc()).toBeNull(); // cloudflared never ran with it
  });

  test("a group- or world-writable ~/.cloudflared is refused before anything", () => {
    const env = h.certMode();
    for (const mode of [0o775, 0o757]) {
      chmodSync(h.cfd, mode);
      const r = h.sh("up", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain("is writable by group or others");
    }
    chmodSync(h.cfd, 0o755);
    expect(h.log()).not.toContain("tunnel create");
    expect(statSync(join(h.cfd, "cert.pem")).mode & 0o777).toBe(0o644); // untouched
  });

  test("a symlinked ~/.cloudflared is refused", () => {
    const env = h.certMode();
    const real = join(h.root, "real-cfd");
    renameSync(h.cfd, real);
    symlinkSync(real, h.cfd);
    const r = h.sh("up", env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is a symlink");
  });

  test("down only ever deletes a credentials file named by a tunnel UUID", () => {
    const env = h.certMode();
    const victim = join(h.root, "victim.json");
    writeFileSync(victim, "keep");
    writeFileSync(join(h.cfd, "lianki-preview.yml"), `tunnel: ../victim\n`, { mode: 0o600 });
    h.sh("down", env);
    expect(existsSync(victim)).toBe(true);
  });

  test("once the API token exists, down removes the cert-made tunnel and DNS through the API", () => {
    const env = h.certMode();
    h.sh("up", env);
    const r = h.sh("down"); // API token present again
    expect(r.code).toBe(0);
    expect(h.log()).toContain("api down");
    expect(existsSync(join(h.cfd, `${UUID}.json`))).toBe(false);
    expect(existsSync(join(h.cfd, "lianki-preview.yml"))).toBe(false);
  });
});
