#!/usr/bin/env bun
/**
 * The lianki CLI. `auth` and `settings` sign in to your account and manage its
 * synced settings (scripts/dev/lianki-auth.ts). `serve` is a macOS background service
 * (launchd LaunchAgent `com.lianki.chat-listener`) that keeps the owner-chat
 * listener running, so chat messages are recorded whenever the chat is open
 * (docs/monitoring.md, "Chat with the agent").
 *
 *   bun run lianki serve install     write the service file and start it
 *   bun run lianki serve start       start it (or nudge it if it is loaded)
 *   bun run lianki serve stop        stop it and keep it stopped (unloads it)
 *   bun run lianki serve restart     stop and start again
 *   bun run lianki serve status      loaded or not, its pid, the last log lines
 *   bun run lianki serve uninstall   stop it and delete the service file
 *
 *   install takes --label "chat lane (fast)" and --out /tmp/lianki-chat-fast.jsonl
 *   (the listener's label and the file it appends one JSON line per event to).
 *
 * Event-driven: launchd restarts the listener only when it exits; nothing
 * polls. The listener resumes its saved chat grant (--no-pair), so a restart
 * never prompts the owner's phone. It runs from this checkout, so keep the
 * checkout in place. Log: ~/Library/Logs/lianki-chat-listener.log.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AUTH_USAGE, authMain } from "./lianki-auth";

export const SERVICE_LABEL = "com.lianki.chat-listener";
export const DEFAULT_CHAT_LABEL = "chat lane (fast)";
export const DEFAULT_OUT = "/tmp/lianki-chat-fast.jsonl";

const USAGE = `usage: lianki serve <install|start|stop|restart|status|uninstall> [--label "${DEFAULT_CHAT_LABEL}"] [--out ${DEFAULT_OUT}]
       ${AUTH_USAGE.replace(/^usage: /, "")}`;

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type ServiceOpts = {
  bun: string;
  repo: string;
  home: string;
  chatLabel: string;
  out: string;
  log: string;
};

/** The LaunchAgent's property list. */
export function serviceFile(o: ServiceOpts): string {
  const args = [
    o.bun,
    "scripts/dev/eval.ts",
    "chat",
    "--label",
    o.chatLabel,
    "--no-pair",
    "--ack",
    "--out",
    o.out,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`${dirname(o.bun)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string>
    <key>HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

const launchctl = (...a: string[]) => {
  const r = Bun.spawnSync(["launchctl", ...a], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
};

function main(argv: string[]): number | Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === "auth" || argv[0] === "settings") return authMain(argv);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { label: { type: "string" }, out: { type: "string" } },
  });
  const [cmd, action] = positionals;
  if (cmd !== "serve" || !action) {
    console.error(`lianki: unknown command\n${USAGE}`);
    return 2;
  }
  if (process.platform !== "darwin") {
    console.error("lianki serve: macOS only (it uses launchd).");
    return 1;
  }

  const home = homedir();
  const plist = join(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
  const log = join(home, "Library/Logs/lianki-chat-listener.log");
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const loaded = () => launchctl("print", target).ok;
  const load = () => {
    const r = launchctl("bootstrap", domain, plist);
    if (!r.ok) console.error(r.out);
    return r.ok;
  };
  const unload = () => (loaded() ? launchctl("bootout", target).ok : true);
  const needInstalled = () => {
    if (existsSync(plist)) return true;
    console.error("lianki serve: not installed. Run: lianki serve install");
    return false;
  };

  switch (action) {
    case "install": {
      const repo = resolve(import.meta.dir, "../..");
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(
        plist,
        serviceFile({
          bun: process.execPath,
          repo,
          home,
          chatLabel: values.label ?? DEFAULT_CHAT_LABEL,
          out: values.out ?? DEFAULT_OUT,
          log,
        }),
      );
      unload();
      if (!load()) return 1;
      console.log(`installed and started: ${plist}\nrunning from ${repo}\nlog: ${log}`);
      return 0;
    }
    case "start": {
      if (!needInstalled()) return 1;
      if (loaded()) launchctl("kickstart", target);
      else if (!load()) return 1;
      console.log("started");
      return 0;
    }
    case "stop": {
      if (!loaded()) {
        console.log("not running");
        return 0;
      }
      console.log(
        unload() ? "stopped (run `lianki serve start` to bring it back)" : "failed to stop",
      );
      return 0;
    }
    case "restart": {
      if (!needInstalled()) return 1;
      if (loaded()) launchctl("kickstart", "-k", target);
      else if (!load()) return 1;
      console.log("restarted");
      return 0;
    }
    case "status": {
      const info = launchctl("print", target);
      if (!info.ok) {
        console.log(existsSync(plist) ? "installed, not running (start it)" : "not installed");
        return 0;
      }
      const pid = info.out.match(/\bpid = (\d+)/)?.[1];
      console.log(
        pid ? `running, pid ${pid}` : "loaded, not running right now (launchd restarts it)",
      );
      if (existsSync(log)) {
        const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-3).join("\n");
        if (tail) console.log(`log:\n${tail}`);
      }
      return 0;
    }
    case "uninstall": {
      unload();
      if (existsSync(plist)) rmSync(plist);
      console.log("uninstalled");
      return 0;
    }
    default:
      console.error(`lianki serve: unknown action "${action}"\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
