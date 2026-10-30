/**
 * scripts/local-stt/server.py end to end, with a saved clip (never the live
 * mic). Runs only where the local STT is installed (docs/local-stt.md): the
 * venv, the SenseVoice model and the owner's clips. Elsewhere (CI) it skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connectLocalStt, readWav } from "../scripts/local-stt/stream-clip-lib";

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");
const MODEL = join(
  homedir(),
  ".cache/lianki-stt/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
);
const CLIP = join(homedir(), "lianki-voice-clips/2026-10-29T14-09-40-446Z-6.wav");
const ready = existsSync(PY) && existsSync(MODEL) && existsSync(CLIP);
const PORT = 5199;

describe.skipIf(!ready)("local STT server (SenseVoice)", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  beforeAll(async () => {
    proc = Bun.spawn(
      [
        PY,
        "-I",
        resolve(import.meta.dir, "../scripts/local-stt/server.py"),
        "--port",
        String(PORT),
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    // Wait for its "listening" line (event-driven: the server's own output).
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!out.includes("listening")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
  }, 30_000);
  afterAll(() => proc?.kill());

  it("streams a clip: partials while it plays, the final right after end", async () => {
    const stt = await connectLocalStt(`ws://127.0.0.1:${PORT}`);
    const { samples } = readWav(new Uint8Array(readFileSync(CLIP)));
    const partials: string[] = [];
    const u = stt.begin((t) => partials.push(t))!;
    // Paced at 8x real time, so partials come while it is "spoken".
    for (let o = 3072; o < samples.length; o += 512) {
      u.frame(samples.subarray(o, o + 512));
      if (o % 4096 === 0) await new Promise((r) => setTimeout(r, 32));
    }
    const f = await u.end(samples);
    stt.close();
    expect(partials.length).toBeGreaterThan(2);
    expect(f.text).toContain("麦克风按钮");
    expect(f.text).toMatch(/[。，]/); // punctuated
    expect(f.model).toBe("local:sensevoice-small-2024-07-17");
    expect(f.endToFinalMs).toBeLessThan(1000);
  }, 30_000);

  it("refuses a page from another origin", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { origin: "https://evil.example" },
    } as never);
    const closed = await new Promise<boolean>((res) => {
      ws.onopen = () => res(false);
      ws.onerror = () => res(true);
      ws.onclose = () => res(true);
    });
    expect(closed).toBe(true);
  });
});
