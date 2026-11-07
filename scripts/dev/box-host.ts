/**
 * Prints the box host of a DEVBOX_PUBLIC_URL, or fails: devbox/host-tunnel.sh's
 * check, so the shell uses the same pattern as the Worker (lib/box-oauth/rules.ts).
 *
 *   bun scripts/dev/box-host.ts https://my-example.lianki.com   # -> my-example.lianki.com
 */
import { isBoxHost } from "../../lib/box-oauth/rules";

export function boxHostOf(url: string | undefined): string | null {
  const m = /^https:\/\/([^/]+)\/?$/.exec((url ?? "").trim());
  return m && isBoxHost(m[1]) ? m[1] : null;
}

if (import.meta.main) {
  const host = boxHostOf(process.argv[2]);
  if (!host) process.exit(1);
  console.log(host);
}
