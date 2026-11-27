/** Server-authored provenance, never an authorization or a command. */
export type PartnerCoordination = {
  v: 1;
  state: "answered";
  from: "owner" | "friend";
  sources: { id: string; text: string }[];
  summary: string;
  targets: string[];
  fromSeq?: number;
  throughSeq?: number;
};

/** A model summary is advisory. Original source ids/text are supplied by the hub. */
export function splitHandoff(raw: string, fallback: string) {
  const blocks = [...raw.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)];
  const text = raw.replace(/<handoff>[\s\S]*?(?:<\/handoff>|$)/g, "").trim();
  let summary = fallback;
  try {
    const value = JSON.parse(blocks.at(-1)?.[1] ?? "null");
    if (typeof value?.text === "string" && value.text.trim() && value.text.length <= 4000)
      summary = value.text;
  } catch {}
  return { text, summary };
}
