/**
 * The grammatical label of an inflected form (lib/read/form-tags.ts): one
 * generic mapping from Wiktionary's tags to UI strings, for every language.
 */
import { describe, expect, it } from "bun:test";
import dict from "@/app/(app)/read/read-form-tags.content";
import {
  FORM_TAG_KEYS,
  FORM_TAGS,
  formLabel,
  formLabels,
  formTagKeys,
  type FormTagKey,
} from "@/lib/read/form-tags";

type Leaf = { translation: Record<string, string> };
const content = dict.content as unknown as Record<FormTagKey, Leaf>;
const strings = (locale: string) =>
  Object.fromEntries(FORM_TAG_KEYS.map((k) => [k, content[k].translation[locale]])) as Record<
    FormTagKey,
    string
  >;
const en = strings("en");
const zh = strings("zh");

describe("form labels", () => {
  it("names the owner's example: passé simple, third-person singular", () => {
    const tags = ["historic", "indicative", "past", "singular", "third-person"];
    expect(formTagKeys(tags)).toEqual([["pastHistoric"], ["person3Singular"]]);
    expect(formLabel(tags, zh)).toBe("简单过去时 · 第三人称单数");
    expect(formLabel(tags, en)).toBe("simple past · third-person singular");
  });

  it("leaves the indicative unsaid unless another mood shares the form", () => {
    expect(formLabel(["indicative", "present", "first-person", "singular"], en)).toBe(
      "present · first-person singular",
    );
    // kaikki merges "regarde": indicative and subjunctive, first and third person.
    const regarde = [
      "first-person",
      "indicative",
      "present",
      "singular",
      "subjunctive",
      "third-person",
    ];
    expect(formLabel(regarde, en)).toBe(
      "indicative / subjunctive · present · first-person singular / third-person singular",
    );
  });

  it("labels nouns: number, gender, case", () => {
    expect(formLabel(["masculine", "plural"], zh)).toBe("复数 · 阳性");
    expect(formLabel(["inessive", "singular"], en)).toBe("inessive (in) · singular");
    expect(formLabel(["partitive", "plural"], en)).toBe("partitive (part of) · plural");
  });

  it("names a Finnish possessor once, its number not repeated", () => {
    const talossani = ["first-person", "inessive", "singular", "singular-possessive"];
    expect(formLabel(talossani, en)).toBe("inessive (in) · possessive: my");
    expect(formLabel(["partitive", "plural", "possessive", "third-person"], en)).toBe(
      "partitive (part of) · plural · possessive: his, her, their",
    );
  });

  it("reads two-tag verb forms before their parts", () => {
    expect(formLabel(["gerund", "participle", "present"], en)).toBe("gerund");
    expect(formLabel(["participle", "past"], en)).toBe("past participle");
    expect(formLabel(["infinitive", "infinitive-i"], en)).toBe("first infinitive");
    expect(formLabel(["active", "conditional", "connegative", "present"], en)).toBe(
      "conditional · present · active · connegative (after a negation)",
    );
  });

  it("skips tags it does not name, and is empty for none", () => {
    expect(formLabel(["rare", "plural"], en)).toBe("plural");
    expect(formLabel([], en)).toBe("");
    expect(formLabel(["dialectal"], en)).toBe("");
  });

  it("accepts intlayer nodes as well as strings", () => {
    const nodes = Object.fromEntries(FORM_TAG_KEYS.map((k) => [k, { value: zh[k] }])) as Record<
      FormTagKey,
      { value: string }
    >;
    expect(formLabel(["plural"], nodes)).toBe("复数");
  });

  it("lists a form's readings once each", () => {
    const sets = [
      ["future", "indicative", "third-person", "singular"],
      ["future", "third-person", "singular"],
      ["comparative"],
    ];
    expect(formLabels(sets, en)).toEqual(["future · third-person singular", "comparative"]);
  });
});

describe("the label strings", () => {
  it("has every label piece in all 16 locales, none empty", () => {
    const locales = Object.keys(content.plural.translation);
    expect(locales.length).toBe(16);
    for (const k of FORM_TAG_KEYS)
      for (const l of locales) expect(content[k]?.translation[l]?.trim(), `${k}.${l}`).toBeTruthy();
    expect(Object.keys(content).sort()).toEqual([...FORM_TAG_KEYS].sort());
  });

  it("keeps the Wiktionary tags every rule needs", () => {
    for (const t of ["past", "historic", "inessive", "singular-possessive", "infinitive-i"])
      expect(FORM_TAGS.has(t)).toBe(true);
    expect(FORM_TAGS.has("rare")).toBe(false);
    expect(FORM_TAGS.has("multiword-construction")).toBe(false);
  });
});
