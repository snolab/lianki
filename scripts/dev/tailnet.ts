/**
 * `tailscale serve` for the dev servers (docs/dev-debug-widget.md,
 * docs/dev-hot-islands.md): mount a local port at a path on this machine's
 * tailnet name — tailnet only, never funnel — and remove it again.
 */
import { spawnSync } from "node:child_process";

/** A `--tailnet` path is like /lianki-widget. */
export const validTailnetPath = (p: string) => /^\/[\w.-]+(\/[\w.-]+)*$/.test(p);

/** This machine's tailnet name, e.g. my-mac.example-tailnet.ts.net. */
export function tailnetHost(): string {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tailscale status failed: ${r.stderr || r.error}`);
  return String((JSON.parse(r.stdout) as { Self: { DNSName: string } }).Self.DNSName).replace(
    /\.$/,
    "",
  );
}

/** Serve http://127.0.0.1:<port> at <host><path>; an error message, or null when it worked. */
export function serveOnTailnet(path: string, port: number): string | null {
  const r = spawnSync(
    "tailscale",
    ["serve", "--bg", "--set-path", path, `http://127.0.0.1:${port}`],
    {
      encoding: "utf8",
    },
  );
  return r.status === 0 ? null : String(r.stderr || r.error);
}

export function unserveOnTailnet(path: string) {
  spawnSync("tailscale", ["serve", "--set-path", path, "off"], { encoding: "utf8" });
}
