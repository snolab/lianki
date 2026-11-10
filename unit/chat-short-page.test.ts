import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { shortPage } from "@lianki/debug-chat/DebugChat";

// Owner, 2026-11-11 01:31 JST: a user without `dev` never sees a connected
// page's full path, ids or device in the chat menu; a short name at most.
describe("chat menu: connected pages for a user without dev", () => {
  it("shows the path's first segment only", () => {
    expect(shortPage("/words/abc123?list=x#card")).toBe("/words");
    expect(shortPage("/reader/6f1e2d")).toBe("/reader");
    expect(shortPage("/")).toBe("/");
    expect(shortPage("")).toBe("/");
    expect(shortPage("/?q=1")).toBe("/");
  });

  it("pairings, devices and the full label are a developer's (owner) only", () => {
    const src = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
    expect(src).toContain('.filter((x) => owner && x.scope !== "chat")');
    expect(src).toContain('.filter((x) => owner && x.scope === "chat" && addable(x))');
    expect(src).toContain('const device = owner ? parts.device : "";');
    expect(src).toContain("title={owner ? pg.label : undefined}");
    // DebugEval's `owner` needs the server's `dev` verdict, and so does remote eval.
    const host = readFileSync("app/components/DebugEval.tsx", "utf8");
    expect(host).toContain("owner={owner && !isFriend && dev}");
    expect(host).toContain("!debugOn() || !devRef.current");
  });
});
