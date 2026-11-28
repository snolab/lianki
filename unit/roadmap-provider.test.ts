import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateObject } from "ai";
import { workersAiStructuredModel } from "@/lib/workers-ai";
import { LooseRoadmapSchema } from "@/lib/roadmap/generate-schema";
import { generateWithRetry } from "@/lib/roadmap/generate";
import { SaveRoadmapSchema } from "@/lib/roadmap/save-schema";

const envKeys = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_TOKEN", "WORKERS_AI_MODEL"] as const;
const originalFetch = globalThis.fetch;
let originalEnv: (string | undefined)[];
const nodes = [1, 2, 3].map((n) => ({ title: `Synthetic step ${n}` }));
const requests: { path: string; body: Record<string, unknown> }[] = [];
let replies: Response[] = [];
let expectedPath = "";

function chat(text = JSON.stringify({ nodes }), finishReason = "stop") {
  return Response.json({
    id: "synthetic",
    object: "chat.completion",
    created: 0,
    model: "synthetic",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}
function responses() {
  return Response.json({
    id: "synthetic",
    created_at: 0,
    model: "synthetic",
    status: "completed",
    output: [
      {
        type: "message",
        id: "synthetic-message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ nodes }), annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  });
}
const generate = (model?: string) =>
  generateObject({
    model: workersAiStructuredModel(model),
    schema: LooseRoadmapSchema,
    prompt: "Generate a synthetic jlpt n1 roadmap",
    maxOutputTokens: 3000,
    maxRetries: 0,
  });
const run = () =>
  generateWithRetry(
    async () => {
      const result = await generate();
      return { object: result.object, usage: result.usage };
    },
    { usd: () => 0.01, fallbackUsd: 0.02 },
    () => {},
  );

describe("roadmap structured provider wire contract (no network)", () => {
  beforeEach(() => {
    originalEnv = envKeys.map((key) => process.env[key]);
    process.env.CLOUDFLARE_ACCOUNT_ID = "synthetic-account";
    process.env.CLOUDFLARE_AI_TOKEN = "synthetic-token";
    delete process.env.WORKERS_AI_MODEL;
    requests.length = 0;
    replies = [];
    expectedPath = "/chat/completions";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const path = `/client/v4/accounts/synthetic-account/ai/v1${expectedPath}`;
      if (
        url.origin !== "https://api.cloudflare.com" ||
        url.pathname !== path ||
        init?.method !== "POST"
      )
        throw new Error("Blocked unexpected synthetic provider request");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ path: expectedPath, body });
      const reply = replies.shift();
      if (!reply) throw new Error("Blocked unexpected additional provider call");
      return reply;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    envKeys.forEach((key, i) => {
      if (originalEnv[i] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[i];
    });
  });

  it("default Llama uses Chat Completions and yields saveable roadmap nodes", async () => {
    replies = [chat()];
    const result = await run();
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(requests[0].body.stream).not.toBe(true);
    expect(result.value.nodes).toHaveLength(3);
    expect(
      SaveRoadmapSchema.safeParse({ topic: "jlpt n1", nodes: result.value.nodes }).success,
    ).toBe(true);
  });

  it.each(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b"])(
    "%s uses nonstream Responses and parses output",
    async (model) => {
      expectedPath = "/responses";
      replies = [responses()];
      const result = await generate(model);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.model).toBe(model);
      expect(requests[0].body.stream).not.toBe(true);
      expect(result.object.nodes).toEqual(nodes);
    },
  );

  it("a configured non-GPT-OSS model retains Chat Completions", async () => {
    process.env.WORKERS_AI_MODEL = "@cf/synthetic/another-text-model";
    replies = [chat()];
    await generate();
    expect(requests[0].body.model).toBe("@cf/synthetic/another-text-model");
  });

  it("real SDK truncated JSON retries once and the successful output saves", async () => {
    replies = [chat('{"nodes":[{"title":"unfinished', "length"), chat()];
    const result = await run();
    expect(requests).toHaveLength(2);
    expect(replies).toHaveLength(0);
    expect(
      SaveRoadmapSchema.safeParse({ topic: "jlpt n1", nodes: result.value.nodes }).success,
    ).toBe(true);
    expect(result.usd).toBeCloseTo(0.02);
  });
});
