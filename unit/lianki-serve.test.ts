import { describe, expect, test } from "bun:test";
import { SERVICE_LABEL, serviceFile } from "../scripts/dev/lianki";

const opts = {
  bun: "/Users/x/.bun/bin/bun",
  repo: "/Users/x/ws/lianki",
  home: "/Users/x",
  chatLabel: 'chat "lane" <fast> & co',
  out: "/tmp/chat.jsonl",
  log: "/Users/x/Library/Logs/lianki-chat-listener.log",
};

describe("lianki serve: the LaunchAgent file", () => {
  const plist = serviceFile(opts);

  test("runs the chat listener without ever pairing, restarted by launchd", () => {
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    for (const a of ["scripts/dev/eval.ts", "chat", "--no-pair", "--ack", "/tmp/chat.jsonl"])
      expect(plist).toContain(`<string>${a}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("escapes the label so a quote or bracket cannot break the XML", () => {
    expect(plist).toContain("chat &quot;lane&quot; &lt;fast&gt; &amp; co");
    expect(plist).not.toContain('chat "lane"');
  });

  test("works from the checkout, with bun's own folder first on PATH", () => {
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/Users/x/ws/lianki</string>");
    expect(plist).toContain("<string>/Users/x/.bun/bin:");
  });
});
