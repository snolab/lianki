import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { oversizedAssets, WORKERS_ASSET_MAX_BYTES } from "../scripts/ci/check-asset-size";

describe("check-asset-size", () => {
  test("lists only files over the limit, nested too, largest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-size-"));
    try {
      mkdirSync(join(dir, "_next/static/media"), { recursive: true });
      writeFileSync(join(dir, "small.js"), "x".repeat(10));
      writeFileSync(join(dir, "edge.bin"), "x".repeat(100));
      writeFileSync(join(dir, "_next/static/media/big.wasm"), "x".repeat(101));
      writeFileSync(join(dir, "bigger.wasm"), "x".repeat(200));
      expect(oversizedAssets(dir, 100)).toEqual([
        { file: "bigger.wasm", bytes: 200 },
        { file: "_next/static/media/big.wasm", bytes: 101 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default limit is the Workers 25 MiB per-asset limit", () => {
    expect(WORKERS_ASSET_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
