// Shared, Workers-native OpenAI helpers. No `ai`/`openai` SDK in the bundle —
// everything is a direct fetch to the OpenAI REST API, mirroring the local
// `openaiJSON` helper in ai.ts but reused by the content/polyglot/self-intro
// ports. API key comes from the Worker secret OPENAI_API_KEY.

const OPENAI_BASE = "https://api.openai.com/v1";

export type ChatMessage = { role: "system" | "user"; content: string };

/** Chat completion constrained to a JSON object; returns the parsed object. */
export async function openaiChatJSON(
  apiKey: string,
  messages: ChatMessage[],
  temperature: number,
  model = "gpt-4o-mini",
): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

/** Plain-text chat completion; returns the trimmed message content. */
export async function openaiChatText(
  apiKey: string,
  messages: ChatMessage[],
  temperature: number,
  model = "gpt-4o-mini",
): Promise<string> {
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/** OpenAI text-to-speech; returns the raw audio bytes (mp3). */
export async function openaiSpeech(
  apiKey: string,
  opts: { model: string; voice: string; input: string; speed?: number },
): Promise<ArrayBuffer> {
  const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      voice: opts.voice,
      input: opts.input,
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.arrayBuffer();
}

/**
 * Streaming chat completion → a ReadableStream of the assistant's text deltas
 * (UTF-8 bytes), parsing the OpenAI SSE `data:` frames. Replaces the `ai` SDK's
 * `streamText`.
 */
export async function openaiChatStream(
  apiKey: string,
  opts: { model: string; system: string; prompt: string },
): Promise<ReadableStream<Uint8Array>> {
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
    }),
  });
  if (!r.ok || !r.body) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          controller.close();
          return;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        } catch {
          // ignore keep-alive / partial frames
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
