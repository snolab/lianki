import { expect, test } from "bun:test";
import { parsePageMessage } from "../lib/dev-eval";
import { cleanRecheckMark } from "../packages/debug-chat/src/wire";
const candidate = {
  at: 123,
  engine: "@cf/openai/whisper-large-v3-turbo",
  heard: "Realtime words.",
  text: "Whole recording words.",
  lang: "en",
  speaker: { decision: "me" },
  hostname: "never retained",
};
test("a second PTT candidate is bounded metadata tied to the untouched realtime body", () => {
  const input = {
    type: "chat",
    id: "ptt",
    source: "stt",
    text: candidate.heard,
    stt: { route: "local", engine: "sensevoice" },
    recheck: candidate,
    speakerProof: ["baseline-proof"],
  };
  const parsed = parsePageMessage(JSON.stringify(input));
  expect(parsed).toMatchObject({
    text: candidate.heard,
    recheck: {
      at: 123,
      engine: candidate.engine,
      heard: candidate.heard,
      text: candidate.text,
      lang: "en",
    },
  });
  expect((parsed as any).recheck).not.toHaveProperty("speaker");
  expect((parsed as any).recheck).not.toHaveProperty("hostname");
  for (const change of [
    { source: undefined },
    { text: candidate.text },
    { recheck: { ...candidate, heard: "unrelated" } },
  ])
    expect(parsePageMessage(JSON.stringify({ ...input, ...change }))).not.toHaveProperty("recheck");
  for (const change of [
    { at: -1 },
    { engine: "bad engine" },
    { text: "x".repeat(4001) },
    { heard: "" },
  ])
    expect(cleanRecheckMark({ ...candidate, ...change })).toBeUndefined();
});

test("cloud prefix metadata requires the complete body and cannot carry realtime speaker authorization", () => {
  const recheck = {
    ...candidate,
    heard: "Live prefix",
    text: "Live prefix and full ending.",
    heardPartial: true,
  };
  const input = {
    type: "chat",
    id: "cloud-ptt",
    source: "stt",
    text: recheck.text,
    stt: { route: "cloud", engine: recheck.engine },
    recheck,
    speakerProof: ["prefix-proof"],
  };
  expect(parsePageMessage(JSON.stringify(input))).toMatchObject({
    text: recheck.text,
    recheck: { heard: recheck.heard, text: recheck.text, heardPartial: true },
  });
  expect(parsePageMessage(JSON.stringify(input))).not.toHaveProperty("speakerProof");
  expect(parsePageMessage(JSON.stringify({ ...input, text: recheck.heard }))).not.toHaveProperty(
    "recheck",
  );
  expect(
    parsePageMessage(JSON.stringify({ ...input, stt: { route: "local" } })),
  ).not.toHaveProperty("recheck");
});
