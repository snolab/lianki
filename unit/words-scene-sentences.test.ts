import { describe, expect, it } from "bun:test";
import { SCENARIOS } from "@/lib/words/phrases";
import { SCENE_CUES, TAG_SCENE } from "@/scripts/words/scene-lexicon";
import {
  hasCue,
  hasName,
  isNarrative,
  normEn,
  pickSceneSentences,
  rankWords,
  rejectReason,
  sentenceBand,
  tagScene,
  usefulness,
  type Candidate,
  type Vocab,
} from "@/scripts/words/scene-sentences";

/** A tiny French vocabulary: word → band; "inconnu" style words are unknown. */
const BANDS: Record<string, number> = {
  où: 1,
  est: 1,
  la: 1,
  le: 1,
  je: 1,
  vous: 1,
  un: 1,
  pas: 1,
  ne: 1,
  comprends: 1,
  aider: 1,
  pouvez: 1,
  me: 1,
  combien: 1,
  ça: 1,
  coûte: 2,
  gare: 2,
  voudrais: 1,
  café: 2,
  pharmacie: 3,
  "aujourd'hui": 1,
  il: 1,
  prit: 2,
  bus: 2,
  rentra: 3,
};
const vocab: Vocab = {
  beyond: 8,
  band: (w) => BANDS[w] ?? null,
  known: (w) => w in BANDS || w === "s" || w === "plaît" || w === "sami",
};
const cand = (id: string, term: string, en: string, tags: string[] = []): Candidate => ({
  id,
  term,
  en,
  by: "author",
  enId: `${id}0`,
  enBy: "en-author",
  tags,
});

describe("the scene lexicon is one list for every language", () => {
  it("covers every scenario, with lowercase English cues", () => {
    expect(Object.keys(SCENE_CUES).sort()).toEqual([...SCENARIOS].sort());
    for (const moments of Object.values(SCENE_CUES))
      for (const [moment, cues] of Object.entries(moments)) {
        expect(moment.length).toBeLessThanOrEqual(40);
        for (const c of cues) expect(c).toBe(c.toLowerCase());
      }
    for (const s of Object.values(TAG_SCENE)) expect(SCENARIOS).toContain(s);
  });
});

describe("tagScene", () => {
  it("places a sentence by the concepts in its English", () => {
    expect(tagScene("Where is the pharmacy?")).toEqual({
      scenario: "health",
      scene: "at the pharmacy",
    });
    expect(tagScene("How much does it cost?")?.scenario).toBe("shopping");
    expect(tagScene("What time does the next train leave?")?.scenario).toBe("transport");
    expect(tagScene("I don't understand.")).toEqual({
      scenario: "help",
      scene: "not understanding",
    });
    expect(tagScene("Call the police!")?.scenario).toBe("emergency");
  });

  it("uses Tatoeba tags, anchors and the other-sense list", () => {
    expect(tagScene("Nice tie!", ["restaurant"])?.scenario).toBe("restaurant");
    expect(tagScene("How are you?")?.scenario).toBe("greetings");
    expect(tagScene("How are you getting home?")).toBeNull();
    expect(tagScene("Take that into account.")).toBeNull();
    expect(tagScene("Help yourself.")).toBeNull();
    expect(tagScene("It's a nice table.")).toBeNull();
  });

  it("matches whole words only", () => {
    const t = normEn("Can I check in now?");
    expect(hasCue(t, "check in")).toBe(true);
    expect(hasCue(normEn("Checking in."), "check in")).toBe(false);
    expect(hasCue(normEn("Hi!"), "^hi$")).toBe(true);
    expect(hasCue(normEn("Hi, Tom!"), "^hi$")).toBe(false);
  });
});

describe("usefulness and narrative", () => {
  it("scores questions, requests and polite formulas up, stories down", () => {
    expect(usefulness("Could you help me, please?")).toBeGreaterThan(usefulness("Help me."));
    expect(usefulness("Where is the station?")).toBeGreaterThan(0);
    expect(usefulness("I got out of the taxi.")).toBeLessThan(0);
    expect(usefulness("Planes land at the airport.")).toBeLessThan(0);
    expect(isNarrative("She looks very sick.")).toBe(true);
    expect(isNarrative("He drank beer.")).toBe(true);
    expect(isNarrative("I feel sick.")).toBe(false);
  });
});

describe("quality filter", () => {
  it("leaves out names, digits, long, unknown, tagged and narrative sentences", () => {
    const r = (term: string, en: string, tags: string[] = []) =>
      rejectReason("fr", cand("1", term, en, tags), vocab);
    expect(r("Où est la gare ?", "Where is the station?")).toBeNull();
    expect(r("Où est la gare, Tom ?", "Where is the station, Tom?")).toBe("name");
    expect(r("Sami prit le bus.", "Sami took the bus.")).toBe("name");
    expect(hasName("Où est la gare ?", "Where is the station?", vocab)).toBe(false);
    expect(r("Il est 3 heures.", "It's 3 o'clock.")).toBe("digits");
    expect(r("un un un un un un un un un", "x")).toBe("long");
    expect(r("Où est la zorglub ?", "Where is the zorglub?")).toBe("unknown word");
    expect(r("Où est la gare ?", "Where is the station?", ["proverb"])).toBe("tag");
    expect(r("Où est la gare ?", "Where is the station?", ["by Victor Hugo"])).toBe("tag");
    expect(r("Il prit le bus.", "He took the bus.")).toBe("narrative");
  });

  it("keeps a word the vocabulary knows whole, drops elided clitics", () => {
    expect(rankWords("Je voudrais un café aujourd'hui.", vocab)).toEqual([
      "je",
      "voudrais",
      "un",
      "café",
      "aujourd'hui",
    ]);
    expect(rankWords("S'il vous plaît.", vocab)).toEqual(["il", "vous", "plaît"]);
  });
});

describe("order: easiest first, then most useful, then shortest", () => {
  it("bands a sentence by its rarest word; unranked words come after every list", () => {
    expect(sentenceBand("Où est la gare ?", vocab)).toBe(2);
    expect(sentenceBand("Où est la pharmacie ?", vocab)).toBe(3);
    expect(sentenceBand("S'il vous plaît.", vocab)).toBe(8);
  });

  it("builds decks per scenario, easiest first, deduped by sentence and by English", () => {
    const { decks, rejected } = pickSceneSentences(
      "fr",
      [
        cand("1", "Où est la pharmacie ?", "Where is the pharmacy?"),
        cand("2", "Combien ça coûte ?", "How much does it cost?"),
        cand("3", "Je ne comprends pas.", "I don't understand."),
        cand("4", "Où est la gare ?", "Where is the station?"),
        cand("5", "Où est la gare ?", "Where's the station?"),
        cand("6", "Où est le gare ?", "Where is the station?"),
        cand("7", "Pouvez-vous m'aider ?", "Can you help me?"),
        cand("8", "Je ne comprends pas !", "I don't understand!"),
        cand("9", "Je voudrais un café.", "Nice weather."),
      ],
      vocab,
    );
    // "Nice weather." is no use to get by: left out, so small-talk has nothing.
    expect([...decks.keys()].sort()).toEqual(["health", "help", "shopping", "transport"]);
    expect(rejected.get("not useful")).toBe(1);
    expect(decks.get("help")!.map((l) => l.term)).toEqual([
      "Pouvez-vous m'aider ?",
      "Je ne comprends pas.",
    ]);
    expect(decks.get("health")![0]).toEqual({
      term: "Où est la pharmacie ?",
      back: "Where is the pharmacy?",
      scene: "at the pharmacy",
      src: "tatoeba:1",
      by: "author",
      enId: "10",
      enBy: "en-author",
      auto: true,
    });
    // One "Where is the station?" is kept: 5 repeats 4's sentence, 6 its English.
    expect(decks.get("transport")!.map((l) => l.src)).toEqual(["tatoeba:4"]);
    expect(rejected.get("repeat")).toBe(3);
  });
});
