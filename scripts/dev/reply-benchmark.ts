/** Read-only: captures the official CLI response in memory and prints aggregates only. */
import { laneToken } from "./lane-listen-lib";
import { replyBenchmark } from "./reply-benchmark-lib";

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const lane = args.includes("--as") ? value("--as") : undefined;
  if (
    !lane ||
    !/^[a-zA-Z0-9._-]{1,40}$/.test(lane) ||
    !args.includes("--threshold-ms") ||
    !args.includes("--window-ms")
  )
    throw Error(
      "Usage: bun scripts/dev/reply-benchmark.ts --as <lane> --threshold-ms <target> --window-ms <matching-window> [--limit 100]",
    );
  const thresholdMs = Number(value("--threshold-ms"));
  const windowMs = Number(value("--window-ms"));
  const limit = args.includes("--limit") ? Number(value("--limit")) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("Invalid limit");
  const { token } = laneToken(lane);
  if (!token) throw Error("Own chat token unavailable");
  const proc = Bun.spawn(
    [
      process.execPath,
      "packages/lianki-cli/lianki.mjs",
      "--api",
      "https://lianki.com",
      "chat",
      "read",
      "--limit",
      String(limit),
      "--json",
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, LIANKI_TOKEN: token },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, , status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A server error could contain private text, so never forward CLI stdout/stderr on failure.
  if (status !== 0) throw Error(`Chat read failed (exit ${status}); no response content logged`);
  const envelope = JSON.parse(out);
  if (!Array.isArray(envelope.data?.messages)) throw Error("Unexpected chat read envelope");
  console.log(
    JSON.stringify(
      {
        environment: "https://lianki.com",
        ...replyBenchmark(envelope.data.messages, {
          thresholdMs,
          windowMs,
          observedAt: Date.now(),
        }),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main)
  void main().catch(() => {
    console.error(
      "Reply benchmark failed; check arguments and own chat token/network. No private response logged.",
    );
    process.exitCode = 1;
  });
