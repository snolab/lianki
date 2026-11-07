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

/** The exit code: 0 with the host printed, 1 with nothing. */
export function main(url: string | undefined, print: (s: string) => void = console.log): number {
  const host = boxHostOf(url);
  if (host) print(host);
  return host ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv[2]));
