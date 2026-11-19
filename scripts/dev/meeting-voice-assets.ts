/** Local static preparation only. No downloading, serving, inference, deployment, or audio I/O. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEETING_VOICE_MODEL_BYTES,
  MEETING_VOICE_MODEL_SHA256,
  type MeetingEmbeddingManifest,
} from "../../lib/meeting-transcription/embedding";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_RUNTIME = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

export interface MeetingVoiceAssetOptions {
  model: string;
  ortDist: string;
  out: string;
  baseUrl: string;
}

function assetBase(raw: string): URL {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const owned = url.hostname === "lianki.com" || url.hostname.endsWith(".lianki.com");
  if (
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    !url.pathname.endsWith("/") ||
    (!local && !owned) ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new Error("Meeting voice base URL must be explicit own HTTPS or HTTP loopback.");
  return url;
}

/** Uses only caller-selected local files, with exact public CAM++ integrity and ORT peer pin. */
export async function prepareMeetingVoiceAssets(
  options: MeetingVoiceAssetOptions,
): Promise<MeetingEmbeddingManifest> {
  const base = assetBase(options.baseUrl);
  const output = resolve(options.out),
    modelPath = resolve(options.model),
    runtimePath = await realpath(resolve(options.ortDist));
  if (basename(output) !== "meeting-voice" || basename(dirname(output)) !== "public")
    throw new Error("Meeting voice output must end in public/meeting-voice.");
  if (
    !(await stat(modelPath)).isFile() ||
    (await stat(modelPath)).size !== MEETING_VOICE_MODEL_BYTES
  )
    throw new Error("Meeting voice model size does not match the approved fp32 asset.");
  const model = await readFile(modelPath);
  if (createHash("sha256").update(model).digest("hex") !== MEETING_VOICE_MODEL_SHA256)
    throw new Error("Meeting voice model integrity check failed.");
  const sdk = join(ROOT, "vendor/otoji/packages/voiceprint-web");
  const requireSdk = createRequire(join(sdk, "package.json"));
  const resolvedRuntime = await realpath(dirname(requireSdk.resolve("onnxruntime-web/wasm")));
  const runtimePackage = JSON.parse(await readFile(join(runtimePath, "../package.json"), "utf8"));
  if (
    resolvedRuntime !== runtimePath ||
    runtimePackage.name !== "onnxruntime-web" ||
    runtimePackage.version !== "1.27.0"
  )
    throw new Error("Meeting voice requires the SDK's installed onnxruntime-web 1.27.0 dist.");
  const files = (await readdir(runtimePath)).filter((name) =>
    /^ort-wasm-simd-threaded(?:\.(?:jsep|jspi|asyncify))?\.(?:mjs|wasm)$/.test(name),
  );
  if (REQUIRED_RUNTIME.some((name) => !files.includes(name)))
    throw new Error("Meeting voice runtime files are incomplete.");
  for (const name of files)
    if (!(await stat(join(runtimePath, name))).isFile())
      throw new Error("Meeting voice runtime files are incomplete.");
  const build = await Bun.build({
    entrypoints: [join(ROOT, "scripts/dev/meeting-voice-worker.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error("Meeting voice worker build failed.");
  const manifest: MeetingEmbeddingManifest = {
    model: {
      id: "campp-zh-en-fp32-v1",
      url: new URL("campp.onnx", base).href,
      bytes: MEETING_VOICE_MODEL_BYTES,
      sha256: MEETING_VOICE_MODEL_SHA256,
      precision: "fp32",
    },
    wasmBaseUrl: new URL("ort/", base).href,
    workerUrl: new URL("meeting-voice-worker.js", base).href,
  };
  await mkdir(join(output, "ort"), { recursive: true });
  // Generated files stay local, even if the chosen preview directory is a checkout.
  await writeFile(join(output, ".gitignore"), "*\n");
  await writeFile(join(output, "campp.onnx"), model);
  for (const name of files) await copyFile(join(runtimePath, name), join(output, "ort", name));
  await Bun.write(join(output, "meeting-voice-worker.js"), build.outputs[0]);
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(output, "README.md"),
    [
      "# Local meeting voice assets",
      "",
      "Generated from an explicitly supplied local CAM++ fp32 file and the vendored SDK's installed onnxruntime-web 1.27.0 runtime.",
      "",
      "These files are ignored and are not uploaded, deployed, or published by this command. Host them only through the separately authorized local preview. There is no Lianki voice embedding API/model service yet; future R2/API hosting is separate work.",
      "",
      "The model is exactly 28,281,164 bytes with SHA-256 aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2. No quantized variant is enabled.",
      "",
      "The application must obtain explicit consent before the first worker warm. PCM inference remains on the device; 192-dimensional vectors are advisory meeting-local data, never identity proofs. No accounts, uploads, or remote fallback are configured.",
      "",
      "This preparation verifies file integrity and builds the worker. It does not establish real speaker accuracy, mobile performance, or that a preview has served the files successfully.",
      "",
    ].join("\n"),
  );
  return manifest;
}

function argumentsFor(args: string[]): MeetingVoiceAssetOptions {
  const values = new Map<string, string>();
  const allowed = ["--model", "--ort-dist", "--out", "--base-url"];
  for (let n = 0; n < args.length; n += 2) {
    if (
      !allowed.includes(args[n]) ||
      !args[n + 1] ||
      args[n + 1].startsWith("--") ||
      values.has(args[n])
    )
      throw new Error("Meeting voice asset arguments are incomplete.");
    values.set(args[n], args[n + 1]);
  }
  if (allowed.some((key) => !values.has(key)))
    throw new Error("Meeting voice requires --model, --ort-dist, --out, and --base-url.");
  return {
    model: values.get("--model")!,
    ortDist: values.get("--ort-dist")!,
    out: values.get("--out")!,
    baseUrl: values.get("--base-url")!,
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(
      "bun scripts/dev/meeting-voice-assets.ts --model /local/campp.onnx --ort-dist /local/onnxruntime-web/dist --out /local/preview/public/meeting-voice --base-url http://127.0.0.1:3000/meeting-voice/\nLocal files only; no downloads, server, inference, or deployment.\n",
    );
  } else {
    try {
      await prepareMeetingVoiceAssets(argumentsFor(process.argv.slice(2)));
      process.stdout.write("Local meeting voice assets prepared.\n");
    } catch {
      process.stderr.write(
        "Meeting voice asset preparation failed; check explicit local paths, approved model integrity, and the SDK's ORT 1.27.0 installation.\n",
      );
      process.exitCode = 1;
    }
  }
}
