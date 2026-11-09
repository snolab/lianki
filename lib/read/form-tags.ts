// The grammatical label of an inflected form in the reader: "regarda" →
// regarder, "简单过去时 · 第三人称单数" (owner, 2026-11-05 00:45 JST: "form →
// lemma" with the form's grammar named).
//
// The tags are English Wiktionary's (kaikki.org `forms[].tags` and the
// form-of senses' tags), one vocabulary shared by every language, kept per
// form in the lemma file (lib/read/lemma.ts, format v2). Nothing here is per
// language: a rule names Wiktionary tags, and the label's words are UI strings
// (app/(app)/reader/read-form-tags.content.ts) in the user's language.

/**
 * The label pieces, in matching order: a rule matches when all its `tags` and
 * `with` tags are on the form and none is taken yet; it takes its `tags` and
 * its `also` tags when present ("infinitive" with "infinitive-i"), and its
 * `with` tags once the rules of its slot are done, so one number serves two
 * persons (Wiktionary's "first-person third-person singular": "regarde").
 * Combinations come before their parts ("past historic" before "past").
 * `slot` orders the pieces in the label: verb form, mood, tense, voice,
 * person, case, number, gender, possessor, degree, polarity; two pieces of
 * one slot are alternatives ("first-person singular / third-person singular").
 * An `unsaidAlone` piece is left out when nothing else fills its slot.
 */
const RULES: readonly {
  tags: readonly string[];
  also?: readonly string[];
  with?: readonly string[];
  piece: FormTagKey;
  slot: number;
  unsaidAlone?: boolean;
}[] = [
  // The possessor (Finnish talossani "in my house"): its person and number.
  {
    tags: ["first-person", "singular-possessive"],
    also: ["singular"],
    piece: "possessor1s",
    slot: 8,
  },
  {
    tags: ["second-person", "singular-possessive"],
    also: ["singular"],
    piece: "possessor2s",
    slot: 8,
  },
  { tags: ["first-person", "plural-possessive"], also: ["plural"], piece: "possessor1p", slot: 8 },
  { tags: ["second-person", "plural-possessive"], also: ["plural"], piece: "possessor2p", slot: 8 },
  { tags: ["third-person", "possessive"], piece: "possessor3", slot: 8 },
  { tags: ["possessive"], piece: "possessive", slot: 8 },
  // Tenses and verb forms named by two tags.
  { tags: ["past", "historic"], piece: "pastHistoric", slot: 2 },
  { tags: ["past", "anterior"], piece: "pastAnterior", slot: 2 },
  { tags: ["gerund"], also: ["participle", "present"], piece: "gerund", slot: 0 },
  { tags: ["agent", "participle"], piece: "agentParticiple", slot: 0 },
  { tags: ["present", "participle"], piece: "presentParticiple", slot: 0 },
  { tags: ["past", "participle"], piece: "pastParticiple", slot: 0 },
  { tags: ["participle"], piece: "participle", slot: 0 },
  { tags: ["infinitive-i-long"], also: ["infinitive"], piece: "infinitive1Long", slot: 0 },
  { tags: ["infinitive-i"], also: ["infinitive"], piece: "infinitive1", slot: 0 },
  { tags: ["infinitive-ii"], also: ["infinitive"], piece: "infinitive2", slot: 0 },
  { tags: ["infinitive-iii"], also: ["infinitive"], piece: "infinitive3", slot: 0 },
  { tags: ["infinitive"], piece: "infinitive", slot: 0 },
  // Person with number.
  { tags: ["first-person"], with: ["singular"], piece: "person1Singular", slot: 4 },
  { tags: ["second-person"], with: ["singular"], piece: "person2Singular", slot: 4 },
  { tags: ["third-person"], with: ["singular"], piece: "person3Singular", slot: 4 },
  { tags: ["first-person"], with: ["plural"], piece: "person1Plural", slot: 4 },
  { tags: ["second-person"], with: ["plural"], piece: "person2Plural", slot: 4 },
  { tags: ["third-person"], with: ["plural"], piece: "person3Plural", slot: 4 },
  { tags: ["first-person"], piece: "person1", slot: 4 },
  { tags: ["second-person"], piece: "person2", slot: 4 },
  { tags: ["third-person"], piece: "person3", slot: 4 },
  { tags: ["fourth-person"], piece: "person4", slot: 4 },
  // Mood: the indicative, the unmarked one, is said only beside another.
  { tags: ["indicative"], piece: "indicative", slot: 1, unsaidAlone: true },
  { tags: ["subjunctive"], piece: "subjunctive", slot: 1 },
  { tags: ["conditional"], piece: "conditional", slot: 1 },
  { tags: ["imperative"], piece: "imperative", slot: 1 },
  { tags: ["potential"], piece: "potential", slot: 1 },
  // Tense.
  { tags: ["present"], piece: "present", slot: 2 },
  { tags: ["past"], piece: "past", slot: 2 },
  { tags: ["future"], piece: "future", slot: 2 },
  { tags: ["imperfect"], piece: "imperfect", slot: 2 },
  { tags: ["perfect"], piece: "perfect", slot: 2 },
  { tags: ["pluperfect"], piece: "pluperfect", slot: 2 },
  // Voice.
  { tags: ["active"], piece: "active", slot: 3 },
  { tags: ["passive"], piece: "passive", slot: 3 },
  { tags: ["reflexive"], piece: "reflexive", slot: 3 },
  // Case.
  { tags: ["nominative"], piece: "nominative", slot: 5 },
  { tags: ["accusative"], piece: "accusative", slot: 5 },
  { tags: ["genitive"], piece: "genitive", slot: 5 },
  { tags: ["dative"], piece: "dative", slot: 5 },
  { tags: ["instrumental"], piece: "instrumental", slot: 5 },
  { tags: ["locative"], piece: "locative", slot: 5 },
  { tags: ["vocative"], piece: "vocative", slot: 5 },
  { tags: ["prepositional"], piece: "prepositional", slot: 5 },
  { tags: ["partitive"], piece: "partitive", slot: 5 },
  { tags: ["inessive"], piece: "inessive", slot: 5 },
  { tags: ["elative"], piece: "elative", slot: 5 },
  { tags: ["illative"], piece: "illative", slot: 5 },
  { tags: ["adessive"], piece: "adessive", slot: 5 },
  { tags: ["ablative"], piece: "ablative", slot: 5 },
  { tags: ["allative"], piece: "allative", slot: 5 },
  { tags: ["essive"], piece: "essive", slot: 5 },
  { tags: ["translative"], piece: "translative", slot: 5 },
  { tags: ["instructive"], piece: "instructive", slot: 5 },
  { tags: ["abessive"], piece: "abessive", slot: 5 },
  { tags: ["comitative"], piece: "comitative", slot: 5 },
  // Number and gender.
  { tags: ["singular"], piece: "singular", slot: 6 },
  { tags: ["plural"], piece: "plural", slot: 6 },
  { tags: ["masculine"], piece: "masculine", slot: 7 },
  { tags: ["feminine"], piece: "feminine", slot: 7 },
  { tags: ["neuter"], piece: "neuter", slot: 7 },
  // Degree and polarity.
  { tags: ["comparative"], piece: "comparative", slot: 9 },
  { tags: ["superlative"], piece: "superlative", slot: 9 },
  { tags: ["connegative"], piece: "connegative", slot: 10 },
  { tags: ["negative"], piece: "negative", slot: 10 },
];

/** The UI string keys of the labels (read-form-tags.content.ts). */
export const FORM_TAG_KEYS = [
  "possessor1s",
  "possessor2s",
  "possessor1p",
  "possessor2p",
  "possessor3",
  "possessive",
  "pastHistoric",
  "pastAnterior",
  "gerund",
  "agentParticiple",
  "presentParticiple",
  "pastParticiple",
  "participle",
  "infinitive1Long",
  "infinitive1",
  "infinitive2",
  "infinitive3",
  "infinitive",
  "person1Singular",
  "person2Singular",
  "person3Singular",
  "person1Plural",
  "person2Plural",
  "person3Plural",
  "person1",
  "person2",
  "person3",
  "person4",
  "indicative",
  "subjunctive",
  "conditional",
  "imperative",
  "potential",
  "present",
  "past",
  "future",
  "imperfect",
  "perfect",
  "pluperfect",
  "active",
  "passive",
  "reflexive",
  "nominative",
  "accusative",
  "genitive",
  "dative",
  "instrumental",
  "locative",
  "vocative",
  "prepositional",
  "partitive",
  "inessive",
  "elative",
  "illative",
  "adessive",
  "ablative",
  "allative",
  "essive",
  "translative",
  "instructive",
  "abessive",
  "comitative",
  "singular",
  "plural",
  "masculine",
  "feminine",
  "neuter",
  "comparative",
  "superlative",
  "connegative",
  "negative",
] as const;

export type FormTagKey = (typeof FORM_TAG_KEYS)[number];

/**
 * The Wiktionary tags a lemma file keeps for a form (scripts/words/build-lemmas.ts):
 * the grammatical ones the labels name. Usage notes ("rare", "archaic"),
 * table markup and the like are dropped there.
 */
export const FORM_TAGS: ReadonlySet<string> = new Set(
  RULES.flatMap((r) => [...r.tags, ...(r.also ?? []), ...(r.with ?? [])]),
);

/**
 * The label's pieces for one tag set, as UI string keys in reading order:
 * one entry per slot, its alternatives together
 * (["subjunctive"], ["present"], ["person1Singular", "person3Singular"]).
 */
export function formTagKeys(tags: readonly string[]): FormTagKey[][] {
  const left = new Set(tags);
  const slots = new Map<number, { keys: FormTagKey[]; said: boolean }>();
  let deferred: string[] = [];
  let slot = -1;
  for (const r of RULES) {
    if (r.slot !== slot) {
      for (const t of deferred) left.delete(t);
      deferred = [];
      slot = r.slot;
    }
    if (!r.tags.every((t) => left.has(t)) || !(r.with ?? []).every((t) => left.has(t))) continue;
    for (const t of r.tags) left.delete(t);
    for (const t of r.also ?? []) left.delete(t);
    deferred.push(...(r.with ?? []));
    const s = slots.get(r.slot) ?? { keys: [], said: false };
    s.keys.push(r.piece);
    if (!r.unsaidAlone) s.said = true;
    slots.set(r.slot, s);
  }
  return [...slots]
    .filter(([, s]) => s.said)
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s.keys);
}

/** Between the label's pieces. */
export const LABEL_SEP = " · ";
/** Between a piece's alternatives. */
export const ALT_SEP = " / ";

/**
 * A form's grammatical label in the user's UI language, from its tags and the
 * read-form-tags strings (`useIntlayer("read-form-tags")`, values as plain
 * strings or intlayer nodes): ["past", "historic", "third-person", "singular"]
 * → "simple past · third-person singular". Empty when no tag is named.
 */
export function formLabel(
  tags: readonly string[],
  strings: Readonly<Record<FormTagKey, string | { value: string }>>,
): string {
  const say = (k: FormTagKey) => {
    const s = strings[k];
    return typeof s === "string" ? s : (s?.value ?? "");
  };
  return formTagKeys(tags)
    .map((alts) => alts.map(say).filter(Boolean).join(ALT_SEP))
    .filter(Boolean)
    .join(LABEL_SEP);
}

/**
 * The labels of a form that has several readings ("regarde": present
 * first-person singular, third-person singular, subjunctive, imperative),
 * each once, in the dictionary's order.
 */
export function formLabels(
  sets: readonly (readonly string[])[],
  strings: Readonly<Record<FormTagKey, string | { value: string }>>,
): string[] {
  const out: string[] = [];
  for (const s of sets) {
    const l = formLabel(s, strings);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}
