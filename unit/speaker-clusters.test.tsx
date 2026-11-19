import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  lineAvatar,
  setOtherAvatar,
  setOtherAvatarBelow,
  OTHER_AVATAR_BELOW,
} from "@lianki/debug-chat/avatar-rules";
import {
  CLUSTER_HUES,
  CLUSTER_ID,
  cleanHues,
  clusterAvatar,
  clusterName,
  clusterShown,
  isHousehold,
  labelOrdinal,
  setSpeakerAvatars,
} from "@lianki/debug-chat/cluster-avatar";
import { clusterAvatar as clusterSvg } from "@lianki/debug-chat/LaneMark";
import {
  type ChatMessage,
  type SpeakerTag,
  cleanSpeaker,
  combineSpeaker,
} from "@lianki/debug-chat/wire";

const line = (speaker: SpeakerTag, m: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  from: "owner",
  label: "/words iPhone",
  text: "hi",
  at: 0,
  speaker,
  ...m,
});

const opts = {
  voiceAvatar: (v: string) => `voice:${v}`,
  clusterAvatar: (c: string) => `cluster:${c}`,
  clusterWords: { voice: "声音 {label}", household: "家人的声音" },
  otherVoice: "Another voice",
};

afterEach(() => {
  setSpeakerAvatars({});
  setOtherAvatar("");
  setOtherAvatarBelow(OTHER_AVATAR_BELOW);
});

describe("the wire: speaker.cluster", () => {
  it("cleanSpeaker keeps a valid label and its score, drops anything else", () => {
    expect(cleanSpeaker({ decision: "other", cluster: "B", clusterScore: 0.71234 })).toEqual({
      decision: "other",
      cluster: "B",
      clusterScore: 0.712,
    });
    expect(cleanSpeaker({ decision: "other", cluster: "household:other" })?.cluster).toBe(
      "household:other",
    );
    for (const bad of ["b", "ABCD", "household:Her Name", "household:", "<A>", 3]) {
      expect(cleanSpeaker({ decision: "other", cluster: bad })).toEqual({ decision: "other" });
    }
    // A score without a label, or out of range: dropped.
    expect(cleanSpeaker({ decision: "other", clusterScore: 0.5 })).toEqual({ decision: "other" });
    expect(cleanSpeaker({ decision: "other", cluster: "A", clusterScore: 7 })).toEqual({
      decision: "other",
      cluster: "A",
    });
    expect(CLUSTER_ID.test("AA")).toBe(true);
  });

  it("combineSpeaker keeps the cluster only when every utterance names the same one", () => {
    const a = { decision: "other", cluster: "A", clusterScore: 0.8 } as const;
    expect(combineSpeaker([a, { ...a, clusterScore: 0.6 }])).toMatchObject({
      cluster: "A",
      clusterScore: 0.6,
    });
    expect(combineSpeaker([a, { ...a, cluster: "B" }])).not.toHaveProperty("cluster");
    expect(combineSpeaker([a, { decision: "other" }])).not.toHaveProperty("cluster");
    expect(combineSpeaker([{ decision: "other", cluster: "C" }])).toEqual({
      decision: "other",
      cluster: "C",
    });
  });
});

describe("cluster-avatar: the disc", () => {
  it("the same label, the same disc; the first letters all differ; oklch only, never the seal red", () => {
    expect(clusterAvatar("A")).toEqual(clusterAvatar("A"));
    const first = Array.from({ length: CLUSTER_HUES.length }, (_, i) =>
      clusterAvatar(String.fromCharCode(65 + i)),
    );
    expect(new Set(first.map((c) => c.hue)).size).toBe(CLUSTER_HUES.length);
    for (const c of first) {
      expect(c.kind).toBe("letter");
      expect(c.bg).toMatch(/^oklch\(/);
      expect(c.fg).toMatch(/^oklch\(/);
      expect(Math.abs(c.hue - 25)).toBeGreaterThanOrEqual(20);
    }
    expect(clusterAvatar("A").letter).toBe("A");
    const h = clusterAvatar("household:other");
    expect(h.letter).toBe("");
    expect(h.kind).toBe("household");
    expect(CLUSTER_HUES).toContain(h.hue);
  });

  it("labels count as the server counts them", () => {
    expect(["A", "Z", "AA", "AB"].map(labelOrdinal)).toEqual([1, 26, 27, 28]);
    expect(isHousehold("household:x")).toBe(true);
    expect(isHousehold("A")).toBe(false);
  });

  it("the palette from config: hues away from the seal red, else the default", () => {
    expect(cleanHues([10, 30, 90, 200, 355])).toEqual([90, 200, 355]);
    expect(cleanHues("x")).toBe(CLUSTER_HUES);
    expect(cleanHues([20, 25])).toBe(CLUSTER_HUES);
    expect(cleanHues([Number.NaN, -1, 400])).toBe(CLUSTER_HUES);
    setSpeakerAvatars({ hues: [100, 200] });
    expect([clusterAvatar("A").hue, clusterAvatar("B").hue, clusterAvatar("C").hue]).toEqual([
      100, 200, 100,
    ]);
  });

  it("names: 'Voice A', the household words, English defaults", () => {
    expect(clusterName("B", { voice: "声音 {label}" })).toBe("声音 B");
    expect(clusterName("B", {})).toBe("Voice B");
    expect(clusterName("household:other", { household: "家人的声音" })).toBe("家人的声音");
    expect(clusterName("household:other", {})).toBe("Household voice");
  });

  it("clusterShown: the flag, a valid label, the minimum score", () => {
    expect(clusterShown("A")).toBe(true);
    expect(clusterShown("nope")).toBe(false);
    expect(clusterShown(undefined)).toBe(false);
    setSpeakerAvatars({ minScore: 0.5 });
    expect(clusterShown("A", 0.4)).toBe(false);
    expect(clusterShown("A", 0.6)).toBe(true);
    setSpeakerAvatars({ minScore: 9 }); // malformed: the default (0)
    expect(clusterShown("A", 0.1)).toBe(true);
    setSpeakerAvatars({ on: false });
    expect(clusterShown("A")).toBe(false);
  });

  it("the SVG: a letter, or a house, on its colour", () => {
    const a = renderToStaticMarkup(clusterSvg("A"));
    expect(a).toContain('data-cluster="A"');
    expect(a).toContain(">A</text>");
    expect(a).toContain("oklch(");
    expect(renderToStaticMarkup(clusterSvg("AB"))).toContain('font-size="9"');
    const h = renderToStaticMarkup(clusterSvg("household:other"));
    expect(h).toContain("<path");
    expect(h).not.toContain("<text");
  });
});

describe("lineAvatar: one avatar per voice in the room", () => {
  it("a decided other with a cluster: its own disc, name and run", () => {
    const a = lineAvatar(
      line({ decision: "other", voice: "s1", cluster: "A", clusterScore: 0.9 }),
      opts,
    );
    expect(a).toMatchObject({
      src: "cluster:A",
      name: "声音 A",
      initialFrom: "A",
      seed: "cluster:A",
    });
    const b = lineAvatar(line({ decision: "other", voice: "s2", cluster: "B" }), opts);
    expect(b.seed).not.toBe(a.seed);
    expect(b.name).toBe("声音 B");
  });

  it("an undecided line well under his print gets its cluster too; one near him keeps his avatar", () => {
    const low = lineAvatar(line({ decision: "unknown", score: 0.2, cluster: "C" }), opts);
    expect(low.seed).toBe("cluster:C");
    const near = lineAvatar(line({ decision: "unknown", score: 0.7, cluster: "C" }), opts);
    expect(near.seed).not.toBe("cluster:C");
    expect(near.unsure).toBe(true);
    setOtherAvatarBelow(0);
    expect(lineAvatar(line({ decision: "unknown", score: 0.2, cluster: "C" }), opts).seed).not.toBe(
      "cluster:C",
    );
  });

  it("never on his own line, nor on a friend's or an agent's", () => {
    expect(lineAvatar(line({ decision: "me", voice: "me", cluster: "A" }), opts).seed).not.toBe(
      "cluster:A",
    );
    expect(
      lineAvatar(line({ decision: "other", cluster: "A" }, { from: "friend" }), opts).seed,
    ).not.toBe("cluster:A");
  });

  it("a household voice: its house, or the picture and name set for another voice", () => {
    const h = lineAvatar(line({ decision: "other", cluster: "household:other" }), opts);
    expect(h).toMatchObject({
      src: "cluster:household:other",
      name: "家人的声音",
      seed: "cluster:household:other",
    });
    setOtherAvatar("https://lianki.com/avatars/x.png", "她");
    const p = lineAvatar(line({ decision: "other", cluster: "household:other" }), opts);
    expect(p).toMatchObject({
      src: ["https://lianki.com/avatars/x.png"],
      name: "她",
      initialFrom: "她",
    });
    // A letter cluster keeps its own disc even then.
    expect(lineAvatar(line({ decision: "other", cluster: "A" }), opts).src).toBe("cluster:A");
  });

  it("falls back to the single other-voice avatar: no cluster, the flag off, a weak score", () => {
    expect(lineAvatar(line({ decision: "other", voice: "s1" }), opts)).toMatchObject({
      src: "voice:s1",
      seed: "voice:s1",
      name: "Another voice",
    });
    setSpeakerAvatars({ on: false });
    expect(lineAvatar(line({ decision: "other", voice: "s1", cluster: "A" }), opts).seed).toBe(
      "voice:s1",
    );
    setSpeakerAvatars({ minScore: 0.5 });
    expect(
      lineAvatar(line({ decision: "other", voice: "s1", cluster: "A", clusterScore: 0.3 }), opts)
        .seed,
    ).toBe("voice:s1");
    // No drawer, no words: the label's initial and the English name.
    expect(lineAvatar(line({ decision: "other", cluster: "D" }), {})).toMatchObject({
      src: undefined,
      name: "Voice D",
      initialFrom: "D",
    });
  });
});
