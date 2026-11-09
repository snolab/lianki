/**
 * Paid provider calls for the routes that call Workers AI directly (the labs,
 * self-intro's translate and speech, the roadmap, the legacy /api/tts): each
 * one held, called with the feature's fixed limit, and settled through
 * `metered` (docs/payments.md, "What costs credits").
 *
 * The limits are per feature and the same for everyone (`MAX_OUT`), never
 * shrunk to fit a balance: not enough for the hold → refused.
 */
import type OpenAI from "openai";
import { metered, type Metered, type Payer } from "./metered";
import type { D1WithBatch } from "./credits-store";
import { speechHoldUsd, speechUsd, sttUsd, textHoldUsd, textUsd, type Feature } from "./prices";

/** The most output tokens each chat feature may produce (its answer's ceiling). */
export const MAX_OUT = {
  "ai-sentences": 1200,
  "polyglot.translate": 3000,
  "self-intro.translate": 600,
  "roadmap.generate": 3000,
  "blog.translate": 32_000,
} as const satisfies Partial<Record<Feature, number>>;

export type PaidPayer = Payer & { db: D1WithBatch | null };

type Msg = { role: string; content: string };
type ChatBody = { model: string; messages: Msg[]; max_tokens: number } & Record<string, unknown>;
type Completion = {
  choices: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};
export type Create = (body: ChatBody) => Promise<Completion>;

const chars = (messages: Msg[]) => messages.reduce((n, m) => n + m.content.length, 0);

/** The hold of a chat call: its prompt at the ceiling, every output token. */
export const chatHoldUsd = (body: Pick<ChatBody, "model" | "messages" | "max_tokens">) =>
  textHoldUsd(body.model, chars(body.messages), body.max_tokens);

/** A chat completion paid from the user's credits. */
export function paidChat(
  payer: PaidPayer,
  what: Feature,
  body: ChatBody,
  create: Create,
): Promise<Metered<Completion>> {
  const hold = chatHoldUsd(body);
  return metered({ d1: payer.db }, payer, { what, holdUsd: hold }, async () => {
    const r = await create(body);
    const u = r.usage;
    const usd =
      u?.prompt_tokens || u?.completion_tokens
        ? textUsd(body.model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0)
        : hold;
    return { value: r, usd };
  });
}

/** The OpenAI client's create, as `paidChat` calls it. */
export const openAiCreate =
  (client: OpenAI): Create =>
  async (body) =>
    (await client.chat.completions.create(body as never)) as unknown as Completion;

/** Speech paid from the user's credits: held by the text's length, settled the same way. */
export function paidSpeech<T>(
  payer: PaidPayer,
  what: Feature,
  text: string,
  run: () => Promise<T>,
  aura = false,
): Promise<Metered<T>> {
  return metered(
    { d1: payer.db },
    payer,
    { what, holdUsd: speechHoldUsd(text.length, aura) },
    async () => ({ value: await run(), usd: speechUsd(text.length, aura) }),
  );
}

/** A transcription paid from the user's credits: held and settled by the audio's size. */
export function paidStt<T>(
  payer: PaidPayer,
  bytes: number,
  run: () => Promise<T>,
): Promise<Metered<T>> {
  const usd = sttUsd(bytes);
  return metered({ d1: payer.db }, payer, { what: "speech.stt", holdUsd: usd }, async () => ({
    value: await run(),
    usd,
  }));
}
