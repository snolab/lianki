import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIPS_ORIGIN,
  MAX_CLIP_BYTES,
  clipName,
  clipsDir,
  handleClips,
  listClips,
} from "@/scripts/dev/clip-sink";
import {
  agreement,
  aggregate,
  benchCode,
  cer,
  distance,
  markdown,
  normalize,
} from "@/scripts/dev/stt-bench-lib";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "clips-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = () => new Date("2026-10-29T12:34:56.789Z");
const upload = (
  dir: string,
  meta: Record<string, unknown> = {},
  audio: Blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
  origin = CLIPS_ORIGIN,
) => {
  const form = new FormData();
  form.append("audio", audio, "u.wav");
  form.append(
    "meta",
    JSON.stringify({
      mime: "audio/wav",
      durationMs: 1500,
      label: "/words pwa",
      transcript: "你好",
      model: "@cf/deepgram/nova-3",
      ...meta,
    }),
  );
  return handleClips(
    new Request("http://localhost/clips", { method: "POST", body: form, headers: { origin } }),
    dir,
    at,
  );
};

describe("clip sink", () => {
  it("keeps the folder configurable, defaulting under the home directory", () => {
    expect(clipsDir({ LIANKI_CLIPS_DIR: "/x/y" })).toBe("/x/y");
    expect(clipsDir({})).toBe(join(homedir(), "lianki-voice-clips"));
    expect(clipName(at(), 3)).toBe("2026-10-29T12-34-56-789Z-3");
  });

  it("saves a clip and its sidecar, lists it with a ref, and serves it — for lianki.com only", async () => {
    const dir = tmp();
    const res = (await upload(dir)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIPS_ORIGIN);
    const { name } = await res.json();
    expect(readdirSync(dir).sort()).toEqual([`${name}.json`, `${name}.wav`]);
    expect(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"))).toEqual({
      at: "2026-10-29T12:34:56.789Z",
      mime: "audio/wav",
      durationMs: 1500,
      label: "/words pwa",
      transcript: "你好",
      model: "@cf/deepgram/nova-3",
    });
    writeFileSync(join(dir, `${name}.ref.txt`), "你好呀\n");
    const list = (await (await handleClips(
      new Request("http://localhost/clips/index.json"),
      dir,
    ))!.json()) as { clips: unknown[] };
    expect(list.clips).toEqual([
      expect.objectContaining({ name, file: `${name}.wav`, ref: "你好呀" }),
    ]);
    const audio = (await handleClips(new Request(`http://localhost/x/clips/${name}.wav`), dir))!;
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(((await upload(dir, {}, undefined, "https://evil.example")) as Response).status).toBe(
      403,
    );
  });

  it("refuses what it should not keep", async () => {
    const dir = tmp();
    const status = async (r: Promise<Response | null>) => (await r)!.status;
    expect(await status(upload(dir, { mime: "video/mp4" }))).toBe(415);
    expect(await status(upload(dir, {}, new Blob([])))).toBe(400);
    expect(await status(upload(dir, {}, new Blob([new Uint8Array(MAX_CLIP_BYTES + 1)])))).toBe(413);
    expect(
      await status(
        handleClips(new Request("http://localhost/clips", { method: "POST", body: "x" }), dir),
      ),
    ).toBe(400);
    expect(
      await status(handleClips(new Request("http://localhost/clips/..%2Fetc%2Fpasswd"), dir)),
    ).toBe(404);
    expect(await status(handleClips(new Request("http://localhost/clips/2026-1.wav"), dir))).toBe(
      404,
    );
    expect(
      await status(
        handleClips(new Request("http://localhost/clips/index.json", { method: "PUT" }), dir),
      ),
    ).toBe(405);
    expect(
      await status(handleClips(new Request("http://localhost/clips", { method: "OPTIONS" }), dir)),
    ).toBe(204);
    expect(await handleClips(new Request("http://localhost/health"), dir)).toBeNull();
    expect(listClips(join(dir, "missing"))).toEqual([]);
  });

  it("takes a bench run's raw results once", async () => {
    const dir = tmp();
    const post = (run: string, body = '{"results":[]}') =>
      handleClips(
        new Request(`http://localhost/clips/bench?run=${run}`, { method: "POST", body }),
        dir,
      ).then((r) => r!.status);
    expect(await post("abcd-12")).toBe(200);
    expect(await post("abcd-12")).toBe(409);
    expect(await post("../x")).toBe(400);
    expect(await post("efgh-34", "nope")).toBe(400);
    expect(readFileSync(join(dir, "bench-raw-abcd-12.json"), "utf8")).toBe('{"results":[]}');
  });

  it("names a clip by the current time when no clock is given", async () => {
    const dir = tmp();
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([9])], { type: "audio/webm" }), "u.webm");
    form.append("meta", "not json");
    const res = await handleClips(
      new Request("http://localhost/clips", { method: "POST", body: form }),
      dir,
    );
    const { name } = await res!.json();
    expect(name).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(readdirSync(dir)).toContain(`${name}.webm`);
  });

  it("a sidecar that is missing or broken still lists the clip", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2026-10-29T00-00-00-000Z-0.webm"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(listClips(dir)).toEqual([
      {
        name: "2026-10-29T00-00-00-000Z-0",
        file: "2026-10-29T00-00-00-000Z-0.webm",
        at: "",
        mime: "",
        durationMs: 0,
        label: "",
        transcript: "",
      },
    ]);
  });
});

describe("bench scoring", () => {
  it("CER and agreement ignore case, width, spaces and punctuation", () => {
    expect(normalize("Hello, ＷＯＲＬＤ！ 你好。")).toEqual([..."helloworld你好"]);
    expect(distance([..."kitten"], [..."sitting"])).toBe(3);
    expect(cer("你好世界", "你好 世界")).toBe(0);
    expect(cer("你好世界", "你好")).toBe(0.5);
    expect(cer("", "x")).toBe(1);
    expect(agreement("abc", "abd")).toBeCloseTo(2 / 3);
    expect(agreement("", "")).toBe(1);
  });

  it("aggregates per clip and model: latency, CER where a ref exists, agreement, cost", () => {
    const clips = [
      {
        name: "c1",
        file: "c1.wav",
        at: "",
        mime: "audio/wav",
        durationMs: 30_000,
        label: "",
        transcript: "",
        ref: "你好世界",
      },
      {
        name: "c2",
        file: "c2.wav",
        at: "",
        mime: "audio/wav",
        durationMs: 30_000,
        label: "",
        transcript: "",
      },
    ];
    const b = aggregate(
      [
        { clip: "c1", model: "@cf/deepgram/nova-3", text: "你好世界", ms: 400, language: "zh" },
        { clip: "c1", model: "@cf/openai/whisper", text: "你好", ms: 800 },
        { clip: "c2", model: "@cf/deepgram/nova-3", text: "hi there", ms: 600 },
        { clip: "c2", model: "@cf/openai/whisper", text: "", ms: 0, error: "502" },
        { clip: "c3", model: "@cf/openai/whisper", text: "?", ms: 10 },
      ],
      clips,
    );
    expect(b.models).toEqual(["@cf/deepgram/nova-3", "@cf/openai/whisper"]);
    expect(b.clips[0].by["@cf/deepgram/nova-3"]).toEqual({
      text: "你好世界",
      ms: 400,
      language: "zh",
      cer: 0,
    });
    expect(b.clips[0].by["@cf/openai/whisper"].cer).toBe(0.5);
    expect(b.summary[0]).toEqual({
      model: "@cf/deepgram/nova-3",
      runs: 2,
      errors: 0,
      meanMs: 500,
      meanCer: 0,
      agreement: 0.5,
      pricePerMin: 0.0052,
      cost: 0.0052,
    });
    expect(b.summary[1]).toMatchObject({
      runs: 3,
      errors: 1,
      meanMs: 405,
      meanCer: 0.5,
      pricePerMin: 0.000453,
      cost: 0.000453,
    });
    const md = markdown(b);
    expect(md).toContain("| @cf/deepgram/nova-3 | 2 | 0 | 500 | 0 | 0.5 | 0.0052 | 0.0052 |");
    const unknown = aggregate([{ clip: "c1", model: "@cf/x/new", text: "a", ms: 1 }], clips);
    expect(unknown.summary[0]).toMatchObject({ pricePerMin: null, cost: null });
    expect(markdown(unknown)).toContain("not listed");
    expect(md).toContain("error: 502");
    expect(md).toContain("你好世界 (400 ms, CER 0)");
    expect(markdown(aggregate([], []))).toContain("# STT bench");
  });

  it("benchCode is a function body that reports back to the sink", () => {
    const code = benchCode("https://box.example/w/", ["m1"], "run-1");
    expect(code).toContain('const sink = "https://box.example/w";');
    expect(code).toContain('"/clips/bench?run=run-1"');
    expect(code).toContain("/api/debug/stt?model=");
    expect(() => new Function(`return (async () => {${code}})`)).not.toThrow();
  });
});
