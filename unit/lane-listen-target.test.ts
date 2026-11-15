/**
 * pickTarget (scripts/dev/lane-listen-lib.ts): which agent a lane's lines go to
 * when the listener knows only the lane's dir. 杰咪's dir held a stale idle
 * antigravity beside the live one, plus the chat lane's own Claude session;
 * `ay send .` refused the ambiguous target and every line was lost
 * (2026-11-15 20:28 JST). The newest agent of the lane's CLI kind wins.
 */
import { describe, expect, it } from "bun:test";
import { type AyRow, pickTarget } from "../scripts/dev/lane-listen-lib";

const DIR = "/r/tree/agy";
const rows: AyRow[] = [
  { pid: 5468, cwd: DIR, cli: "agy", status: "active", started_at: "2026-11-15T01:00:00Z" },
  { pid: 78022, cwd: DIR, cli: "agy", status: "active", started_at: "2026-11-15T06:10:00Z" },
  { pid: 89048, cwd: DIR, cli: "claude", status: "active", started_at: "2026-11-14T20:00:00Z" },
  {
    pid: 64893,
    cwd: "/r/tree/coco-ui",
    cli: "codex",
    status: "active",
    started_at: "2026-11-15T03:00:00Z",
  },
  { pid: 111, cwd: DIR, cli: "agy", status: "exited", started_at: "2026-11-15T08:00:00Z" },
];

describe("pickTarget", () => {
  it("the newest alive agent of the lane's CLI kind in the dir", () => {
    expect(pickTarget(rows, DIR, "agy")).toBe("78022");
  });
  it("without a CLI kind, the newest alive agent in the dir, whatever it runs", () => {
    expect(pickTarget(rows, DIR)).toBe("78022");
  });
  it("another dir, an exited agent, or an unknown kind: nothing", () => {
    expect(pickTarget(rows, "/r/tree/none", "agy")).toBeNull();
    expect(pickTarget(rows, DIR, "gemini")).toBeNull();
    expect(pickTarget([rows[4]!], DIR, "agy")).toBeNull();
  });
  it("no start time: the higher pid is the newer one", () => {
    const bare: AyRow[] = [
      { pid: 10, cwd: DIR, cli: "agy" },
      { pid: 20, cwd: DIR, cli: "agy" },
    ];
    expect(pickTarget(bare, DIR, "agy")).toBe("20");
  });
});
