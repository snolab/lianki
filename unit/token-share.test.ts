import { expect, it } from "bun:test";
import {
  agentGuideWithToken,
  agentGuideUrl,
  agentGuidePointer,
  guideStrings,
} from "@/lib/agent-guide";
import guideDictionary from "@/lib/agent-guide.content";
import tokenDictionary from "@/app/components/api-tokens.content";
import { INVITE_PREFILL } from "@lianki/debug-chat/presence";
import { newSecret } from "@/lib/api-tokens";

const locales = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];

it("chat-only preset grants exactly the chat operations, without study or eval", () => {
  expect([...INVITE_PREFILL.scopes].sort()).toEqual(["chat:ask", "chat:read", "chat:write"]);
});

it("every locale's combined message contains the guide for the granted scopes and the one-time token", () => {
  const token = newSecret();
  for (const lang of locales) {
    const template = (
      tokenDictionary.content.shareMessage as unknown as { translation: Record<string, string> }
    ).translation[lang]!;
    expect(template).toContain("{url}");
    expect(template).toContain("{token}");
    const message = agentGuideWithToken({ scopes: INVITE_PREFILL.scopes, lang, token, template });
    expect(message).toContain(agentGuideUrl(INVITE_PREFILL.scopes, lang));
    expect(message).toContain(`LIANKI_TOKEN=${token}`);
    expect(message.split(token)).toHaveLength(2);
    expect(message).not.toContain("{url}");
    expect(message).not.toContain("{token}");
    expect(message).not.toContain("scopes=study");
    const pointer = agentGuidePointer({
      scopes: INVITE_PREFILL.scopes,
      lang,
      name: "assistant",
      t: guideStrings(guideDictionary.content, lang),
    });
    expect(pointer).not.toContain(token);
  }
});

it("combined message keeps scope filtering and literal replacement characters out of URL parameters", () => {
  const token = "fixture-$&-$`-${url}";
  const message = agentGuideWithToken({
    scopes: ["study"],
    lang: "ja",
    token,
    template: "{url}\nLIANKI_TOKEN={token}",
  });
  expect(message).toBe(`${agentGuideUrl(["study"], "ja")}\nLIANKI_TOKEN=${token}`);
  const url = new URL(message.split("\n")[0]!);
  expect(url.searchParams.get("scopes")).toBe("study");
  expect(url.toString()).not.toContain(token);
});
