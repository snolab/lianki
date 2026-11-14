import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceDetailRows } from "../packages/debug-chat/src/MessageDetails";
import { EXTRA } from "../packages/debug-chat/src/chat-ui-locales";
import { UI_EN } from "../packages/debug-chat/src/ui-strings";
import type { ChatMessage } from "../packages/debug-chat/src/wire";

const base: ChatMessage = {
  id: "voice",
  from: "owner",
  label: "",
  text: "Hi",
  at: 1,
  source: "stt",
};
test("voice detail rows render observed facts and keep unrecorded recognition, polish and playback fields absent", () => {
  const html = renderToStaticMarkup(
    <VoiceDetailRows
      message={{
        ...base,
        stt: { route: "cloud", engine: "whisper-test" },
        speaker: { decision: "unknown", score: 0, reason: "short" },
      }}
      words={EXTRA.en}
      ui={UI_EN}
    />,
  );
  expect(html).toContain('data-field="recognitionModel"');
  expect(html).toContain("whisper-test");
  expect(html).toContain(EXTRA.en.voiceDecisionUnknown);
  expect(html).toMatch(/data-field="speakerScore"[^>]*>0</);
  expect(html).not.toContain('data-field="speakerModel"');
  expect(html).not.toContain('data-field="polishedBy"');
  expect(html).not.toContain("clone:owner");
  expect(renderToStaticMarkup(<VoiceDetailRows message={base} words={EXTRA.en} ui={UI_EN} />)).toBe(
    "",
  );
  expect(
    renderToStaticMarkup(
      <VoiceDetailRows
        message={{
          ...base,
          source: undefined,
          from: "agent",
          edited: { by: "agent", at: 1, count: 1 },
        }}
        words={EXTRA.en}
        ui={UI_EN}
      />,
    ),
  ).toBe("");
});
