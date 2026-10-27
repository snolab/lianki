#!/usr/bin/env bun
/**
 * Builds the bidirectional alphabet / writing-system drill lists for /alphabet.
 *
 *   bun scripts/alphabets/build-alphabets.ts [out-dir] [--unihan Unihan_Readings.txt]
 *
 * out-dir defaults to public/alphabets. The Mandarin syllable lists need the
 * Unicode Unihan database; without --unihan the script downloads
 * https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip into the OS temp
 * dir (cached) and extracts Unihan_Readings.txt with `unzip`.
 *
 * Every table below is hand-written from published romanization / IPA
 * standards (see public/alphabets/SOURCES.md). No downloads are needed.
 *
 * Each list is a sequence of items. An item emits a forward card
 * (symbol → sound) followed by its reverse card (sound → symbol). When several
 * items share a reverse term (e.g. じ and ぢ are both "ji"), they are merged
 * into ONE reverse card whose back lists every symbol ("じ / ぢ"), emitted
 * right after the last member of the group. The build fails if any card term
 * repeats within a list or a forward card ends up without a reverse.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZhSyllables } from "./zh-syllables";

const args = process.argv.slice(2);
const unihanFlag = args.indexOf("--unihan");
const UNIHAN_ARG = unihanFlag >= 0 ? args.splice(unihanFlag, 2)[1] : undefined;

async function unihanReadings(): Promise<string> {
  if (UNIHAN_ARG) return UNIHAN_ARG;
  const dir = join(tmpdir(), "lianki-unihan");
  const txt = join(dir, "Unihan_Readings.txt");
  if (existsSync(txt)) return txt;
  mkdirSync(dir, { recursive: true });
  const url = "https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip";
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Unihan download failed: ${res.status}`);
  writeFileSync(join(dir, "Unihan.zip"), Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", join(dir, "Unihan.zip"), "Unihan_Readings.txt", "-d", dir]);
  return txt;
}
const ZH = buildZhSyllables(await unihanReadings());
if (ZH.skipped.length) console.log(`zh: skipped non-standard readings: ${ZH.skipped.join(" ")}`);

type Item = {
  /** front of the forward card (the symbol / spelling) */
  t: string;
  /** back of the forward card (sound / romanization / name) */
  b: string;
  /** short hint shown on both directions (sound only, never the symbol) */
  r?: string;
  /** hint on the forward card only (may reveal the reverse answer) */
  fr?: string;
  /** reverse card term; defaults to `b` */
  rev?: string;
};

type ListDef = {
  id: string;
  lang: string;
  name: string;
  level: string;
  source: string;
  license?: string;
  items: Item[];
};

type Entry = { term: string; back: string; reading?: string };

const LICENSE = "CC0 (factual tables)";
const UNIHAN_LICENSE = "Unicode License v3 (Unihan data); CC0 (pinyin–zhuyin tables)";

/** "あ a い i" → items; tokens alternate symbol / back. */
function P(s: string, extra: (it: Item) => Item = (x) => x): Item[] {
  const tok = s.trim().split(/\s+/);
  if (tok.length % 2) throw new Error(`odd token count in: ${s.slice(0, 40)}`);
  const out: Item[] = [];
  for (let i = 0; i < tok.length; i += 2) out.push(extra({ t: tok[i], b: tok[i + 1] }));
  return out;
}

/** Override fields of items by front term. */
function patch(items: Item[], fix: Record<string, Partial<Item>>): Item[] {
  const seen = new Set<string>();
  const out = items.map((it) => {
    if (fix[it.t]) {
      seen.add(it.t);
      return { ...it, ...fix[it.t] };
    }
    return it;
  });
  for (const k of Object.keys(fix)) if (!seen.has(k)) throw new Error(`patch: no item ${k}`);
  return out;
}

// ---------------------------------------------------------------- Japanese
// Modified Hepburn romanization.
const HIRA_GOJUON = P(`
あ a い i う u え e お o
か ka き ki く ku け ke こ ko
さ sa し shi す su せ se そ so
た ta ち chi つ tsu て te と to
な na に ni ぬ nu ね ne の no
は ha ひ hi ふ fu へ he ほ ho
ま ma み mi む mu め me も mo
や ya ゆ yu よ yo
ら ra り ri る ru れ re ろ ro
わ wa を o ん n
`);
const HIRA_DAKUTEN = P(`
が ga ぎ gi ぐ gu げ ge ご go
ざ za じ ji ず zu ぜ ze ぞ zo
だ da ぢ ji づ zu で de ど do
ば ba び bi ぶ bu べ be ぼ bo
ぱ pa ぴ pi ぷ pu ぺ pe ぽ po
`);
const HIRA_YOON = P(`
きゃ kya きゅ kyu きょ kyo
しゃ sha しゅ shu しょ sho
ちゃ cha ちゅ chu ちょ cho
にゃ nya にゅ nyu にょ nyo
ひゃ hya ひゅ hyu ひょ hyo
みゃ mya みゅ myu みょ myo
りゃ rya りゅ ryu りょ ryo
ぎゃ gya ぎゅ gyu ぎょ gyo
じゃ ja じゅ ju じょ jo
びゃ bya びゅ byu びょ byo
ぴゃ pya ぴゅ pyu ぴょ pyo
`);
const KANA_FIX: Record<string, Partial<Item>> = {
  を: { b: "o (wo)", rev: "wo", r: "object particle; sounds like お" },
  ん: { r: "/n/ ~ /m/ ~ /ŋ/ ~ /ɴ/ by context" },
  ふ: { r: "/ɸɯ/" },
  つ: { r: "/tsɯ/" },
  ぢ: { r: "same sound as じ" },
  づ: { r: "same sound as ず" },
};
const hiraToKata = (s: string) =>
  [...s]
    .map((c) => {
      const n = c.codePointAt(0)!;
      return n >= 0x3041 && n <= 0x3096 ? String.fromCodePoint(n + 0x60) : c;
    })
    .join("");
const toKata = (items: Item[]) =>
  items.map((it) => ({ ...it, t: hiraToKata(it.t), r: it.r?.replace(/[ぁ-ゖ]/g, hiraToKata) }));
const kanaFixKata = Object.fromEntries(
  Object.entries(KANA_FIX).map(([k, v]) => [
    hiraToKata(k),
    { ...v, r: v.r?.replace(/[ぁ-ゖ]+/g, hiraToKata) },
  ]),
);
const KATA_EXTENDED = patch(
  P(`
ファ fa フィ fi フェ fe フォ fo
ティ ti ディ di トゥ tu ドゥ du
ウィ wi ウェ we ウォ wo
ヴ vu ヴァ va ヴィ vi ヴェ ve ヴォ vo
シェ she ジェ je チェ che
ツァ tsa ツォ tso イェ ye
テュ tyu デュ dyu フュ fyu
`),
  { ウォ: { rev: "wo · loanword" } },
);

// ---------------------------------------------------------------- Korean
// Revised Romanization of Korean (2000) + IPA.
const HANGUL_JAMO: Item[] = [
  { t: "ㄱ", b: "g", r: "/k/~/ɡ/ · final k" },
  { t: "ㄴ", b: "n", r: "/n/" },
  { t: "ㄷ", b: "d", r: "/t/~/d/ · final t" },
  { t: "ㄹ", b: "r / l", r: "/ɾ/~/l/ · final l" },
  { t: "ㅁ", b: "m", r: "/m/" },
  { t: "ㅂ", b: "b", r: "/p/~/b/ · final p" },
  { t: "ㅅ", b: "s", r: "/s/ · final t" },
  { t: "ㅇ", b: "ng", r: "silent as initial · final /ŋ/" },
  { t: "ㅈ", b: "j", r: "/tɕ/~/dʑ/ · final t" },
  { t: "ㅊ", b: "ch", r: "/tɕʰ/ · final t" },
  { t: "ㅋ", b: "k", r: "/kʰ/" },
  { t: "ㅌ", b: "t", r: "/tʰ/" },
  { t: "ㅍ", b: "p", r: "/pʰ/" },
  { t: "ㅎ", b: "h", r: "/h/" },
  { t: "ㄲ", b: "kk", r: "/k͈/ tense" },
  { t: "ㄸ", b: "tt", r: "/t͈/ tense" },
  { t: "ㅃ", b: "pp", r: "/p͈/ tense" },
  { t: "ㅆ", b: "ss", r: "/s͈/ tense" },
  { t: "ㅉ", b: "jj", r: "/t͈ɕ/ tense" },
  { t: "ㅏ", b: "a", r: "/a/" },
  { t: "ㅑ", b: "ya", r: "/ja/" },
  { t: "ㅓ", b: "eo", r: "/ʌ/" },
  { t: "ㅕ", b: "yeo", r: "/jʌ/" },
  { t: "ㅗ", b: "o", r: "/o/" },
  { t: "ㅛ", b: "yo", r: "/jo/" },
  { t: "ㅜ", b: "u", r: "/u/" },
  { t: "ㅠ", b: "yu", r: "/ju/" },
  { t: "ㅡ", b: "eu", r: "/ɯ/" },
  { t: "ㅣ", b: "i", r: "/i/" },
  { t: "ㅐ", b: "ae", r: "/ɛ/" },
  { t: "ㅒ", b: "yae", r: "/jɛ/" },
  { t: "ㅔ", b: "e", r: "/e/" },
  { t: "ㅖ", b: "ye", r: "/je/" },
  { t: "ㅘ", b: "wa", r: "/wa/" },
  { t: "ㅙ", b: "wae", r: "/wɛ/" },
  { t: "ㅚ", b: "oe", r: "/ø/ ~ /we/" },
  { t: "ㅝ", b: "wo", r: "/wʌ/" },
  { t: "ㅞ", b: "we", r: "/we/" },
  { t: "ㅟ", b: "wi", r: "/y/ ~ /wi/" },
  { t: "ㅢ", b: "ui", r: "/ɰi/" },
];

// Syllable blocks are romanized algorithmically (RR, syllable in isolation:
// final consonants take their final-position value).
const RR_INITIAL = [
  "g",
  "kk",
  "n",
  "d",
  "tt",
  "r",
  "m",
  "b",
  "pp",
  "s",
  "ss",
  "",
  "j",
  "jj",
  "ch",
  "k",
  "t",
  "p",
  "h",
];
const RR_MEDIAL = [
  "a",
  "ae",
  "ya",
  "yae",
  "eo",
  "e",
  "yeo",
  "ye",
  "o",
  "wa",
  "wae",
  "oe",
  "yo",
  "u",
  "wo",
  "we",
  "wi",
  "yu",
  "eu",
  "ui",
  "i",
];
const RR_FINAL = [
  "",
  "k",
  "k",
  "k",
  "n",
  "n",
  "n",
  "t",
  "l",
  "k",
  "m",
  "l",
  "l",
  "l",
  "p",
  "l",
  "m",
  "p",
  "p",
  "t",
  "t",
  "ng",
  "t",
  "t",
  "k",
  "t",
  "p",
  "t",
];
const JAMO_INITIAL = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JAMO_MEDIAL = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JAMO_FINAL = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
function hangulSyllable(s: string): Item {
  const n = s.codePointAt(0)! - 0xac00;
  if (n < 0 || n > 11171 || s.length !== 1) throw new Error(`not a syllable: ${s}`);
  const i = Math.floor(n / 588);
  const m = Math.floor((n % 588) / 28);
  const f = n % 28;
  const parts = [JAMO_INITIAL[i], JAMO_MEDIAL[m], JAMO_FINAL[f]].filter(Boolean);
  return { t: s, b: RR_INITIAL[i] + RR_MEDIAL[m] + RR_FINAL[f], fr: parts.join(" + ") };
}
// ~100 high-frequency syllable blocks in Korean text, simple open syllables first.
const HANGUL_COMMON = `
가 나 다 라 마 바 사 아 자 차 카 타 파 하
거 너 도 로 모 보 소 오 조 고 구 누 두 루 무 부 수 우 주 추
그 느 드 르 므 브 스 으 즈
기 니 디 리 미 비 시 이 지 치 키 티 피 히
개 내 대 래 매 배 새 애 재 해 게 네 데 레 메 베 세 에 제 케 테 페 헤
요 유 여 야 의 위 와 워 왜 회 화 과 쓰 까 때 또 빠 싸 짜
한 국 일 인 말 물 불 집 밥 맛 것 있 없 학 생 년 날 사 할 들 을 는 은 를 정 상 장 전 선 원 문 신 실 안 중 동 공 경
`;
function hangulCommonItems(): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const s of HANGUL_COMMON.trim().split(/\s+/)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(hangulSyllable(s));
  }
  return out;
}

// ---------------------------------------------------------------- Chinese
// Zhuyin (Bopomofo) ↔ Hanyu Pinyin.
const ZHUYIN = patch(
  P(`
ㄅ b ㄆ p ㄇ m ㄈ f
ㄉ d ㄊ t ㄋ n ㄌ l
ㄍ g ㄎ k ㄏ h
ㄐ j ㄑ q ㄒ x
ㄓ zh ㄔ ch ㄕ sh ㄖ r
ㄗ z ㄘ c ㄙ s
ㄧ i ㄨ u ㄩ ü
ㄚ a ㄛ o ㄜ e ㄝ ê
ㄞ ai ㄟ ei ㄠ ao ㄡ ou
ㄢ an ㄣ en ㄤ ang ㄥ eng ㄦ er
ㄧㄚ ia ㄧㄝ ie ㄧㄠ iao ㄧㄡ iu ㄧㄢ ian ㄧㄣ in ㄧㄤ iang ㄧㄥ ing
ㄨㄚ ua ㄨㄛ uo ㄨㄞ uai ㄨㄟ ui ㄨㄢ uan ㄨㄣ un ㄨㄤ uang ㄨㄥ ong
ㄩㄝ üe ㄩㄢ üan ㄩㄣ ün ㄩㄥ iong
`),
  {
    ㄧ: { b: "i (y-)", rev: "i" },
    ㄨ: { b: "u (w-)", rev: "u" },
    ㄩ: { b: "ü (yu-)", rev: "ü" },
    ㄧㄡ: { b: "iu (iou)", rev: "iu" },
    ㄨㄟ: { b: "ui (uei)", rev: "ui" },
    ㄨㄣ: { b: "un (uen)", rev: "un" },
    ㄨㄥ: { b: "ong (weng)", rev: "ong" },
  },
);

const PINYIN: Item[] = [
  ...P(`
b /p/ p /pʰ/ m /m/ f /f/
d /t/ t /tʰ/ n /n/ l /l/
g /k/ k /kʰ/ h /x/
j /tɕ/ q /tɕʰ/ x /ɕ/
zh /ʈʂ/ ch /ʈʂʰ/ sh /ʂ/ r /ʐ/
z /ts/ c /tsʰ/ s /s/
y /j/ w /w/
`),
  ...patch(
    P(`
a /a/ o /o/ e /ɤ/ i /i/ u /u/ ü /y/
ai /aɪ̯/ ei /eɪ̯/ ao /ɑʊ̯/ ou /oʊ̯/
an /an/ en /ən/ ang /ɑŋ/ eng /əŋ/ ong /ʊŋ/ er /aɚ/
ia /ja/ ie /jɛ/ iao /jɑʊ̯/ iu /joʊ̯/ ian /jɛn/ in /in/ iang /jɑŋ/ ing /iŋ/ iong /jʊŋ/
ua /wa/ uo /wo/ uai /waɪ̯/ ui /weɪ̯/ uan /wan/ un /wən/ uang /wɑŋ/ ueng /wəŋ/
üe /ɥɛ/ üan /ɥɛn/ ün /yn/
`),
    {
      i: { r: "after z c s: /ɨ/; after zh ch sh r: /ʐ̩/" },
      u: { r: "after j q x y it is ü" },
      o: { r: "after b p m f: /wo/" },
      er: { r: "also /ɚ/" },
      ian: { r: "also /jæn/" },
    },
  ),
];

// ---------------------------------------------------------------- Cyrillic
// Romanization: BGN/PCGN (Russian); Ukrainian national 2010 system.
const RUSSIAN: Item[] = [
  { t: "А а", b: "a", r: "/a/" },
  { t: "Б б", b: "b", r: "/b/" },
  { t: "В в", b: "v", r: "/v/" },
  { t: "Г г", b: "g", r: "/ɡ/" },
  { t: "Д д", b: "d", r: "/d/" },
  { t: "Е е", b: "ye", r: "/je/; e after consonants" },
  { t: "Ё ё", b: "yo", r: "/jo/; always stressed" },
  { t: "Ж ж", b: "zh", r: "/ʐ/" },
  { t: "З з", b: "z", r: "/z/" },
  { t: "И и", b: "i", r: "/i/" },
  { t: "Й й", b: "y (short i)", rev: "y · /j/", r: "/j/" },
  { t: "К к", b: "k", r: "/k/" },
  { t: "Л л", b: "l", r: "/l/" },
  { t: "М м", b: "m", r: "/m/" },
  { t: "Н н", b: "n", r: "/n/" },
  { t: "О о", b: "o", r: "/o/; unstressed /ɐ/" },
  { t: "П п", b: "p", r: "/p/" },
  { t: "Р р", b: "r", r: "/r/ trilled" },
  { t: "С с", b: "s", r: "/s/" },
  { t: "Т т", b: "t", r: "/t/" },
  { t: "У у", b: "u", r: "/u/" },
  { t: "Ф ф", b: "f", r: "/f/" },
  { t: "Х х", b: "kh", r: "/x/" },
  { t: "Ц ц", b: "ts", r: "/ts/" },
  { t: "Ч ч", b: "ch", r: "/tɕ/" },
  { t: "Ш ш", b: "sh", r: "/ʂ/" },
  { t: "Щ щ", b: "shch", r: "/ɕː/" },
  { t: "Ъ ъ", b: "hard sign", r: "no sound; separates" },
  { t: "Ы ы", b: "y", rev: "y · /ɨ/", r: "/ɨ/" },
  { t: "Ь ь", b: "soft sign", r: "softens the consonant before /ʲ/" },
  { t: "Э э", b: "e", r: "/ɛ/" },
  { t: "Ю ю", b: "yu", r: "/ju/" },
  { t: "Я я", b: "ya", r: "/ja/" },
];
const UKRAINIAN: Item[] = [
  { t: "Г г", b: "h", r: "/ɦ/ (Russian г = g)" },
  { t: "Ґ ґ", b: "g", r: "/ɡ/" },
  { t: "Е е", b: "e", r: "/ɛ/ (Russian е = ye)" },
  { t: "Є є", b: "ye", r: "/jɛ/" },
  { t: "И и", b: "y", r: "/ɪ/ (Russian и = i)" },
  { t: "І і", b: "i", r: "/i/" },
  { t: "Ї ї", b: "yi", r: "/ji/" },
  { t: "Щ щ", b: "shch", r: "/ʃtʃ/" },
];

// ---------------------------------------------------------------- Greek
const greek = (t: string, name: string, rom: string, ipa: string): Item => ({
  t,
  b: `${name} — ${rom}`,
  r: ipa,
  rev: name,
});
const GREEK: Item[] = [
  greek("Α α", "alpha", "a", "/a/"),
  greek("Β β", "beta", "v", "/v/"),
  greek("Γ γ", "gamma", "g", "/ɣ/; /ʝ/ before e, i"),
  greek("Δ δ", "delta", "d", "/ð/"),
  greek("Ε ε", "epsilon", "e", "/e/"),
  greek("Ζ ζ", "zeta", "z", "/z/"),
  greek("Η η", "eta", "i", "/i/"),
  greek("Θ θ", "theta", "th", "/θ/"),
  greek("Ι ι", "iota", "i", "/i/"),
  greek("Κ κ", "kappa", "k", "/k/"),
  greek("Λ λ", "lambda", "l", "/l/"),
  greek("Μ μ", "mu", "m", "/m/"),
  greek("Ν ν", "nu", "n", "/n/"),
  greek("Ξ ξ", "xi", "x", "/ks/"),
  greek("Ο ο", "omicron", "o", "/o/"),
  greek("Π π", "pi", "p", "/p/"),
  greek("Ρ ρ", "rho", "r", "/r/"),
  greek("Σ σ ς", "sigma", "s", "/s/; ς at word end"),
  greek("Τ τ", "tau", "t", "/t/"),
  greek("Υ υ", "upsilon", "y", "/i/"),
  greek("Φ φ", "phi", "f", "/f/"),
  greek("Χ χ", "chi", "ch", "/x/; /ç/ before e, i"),
  greek("Ψ ψ", "psi", "ps", "/ps/"),
  greek("Ω ω", "omega", "o", "/o/"),
];

// ---------------------------------------------------------------- Arabic / Hebrew
const named = (t: string, name: string, sound: string, ipa?: string): Item => ({
  t,
  b: `${name} — ${sound}`,
  ...(ipa ? { r: ipa } : {}),
  rev: name,
});
// Names and transliteration: DIN 31635 / ALA-LC style.
const ARABIC: Item[] = [
  named("ا", "alif", "ā", "/aː/; carries hamza"),
  named("ب", "bāʼ", "b", "/b/"),
  named("ت", "tāʼ", "t", "/t/"),
  named("ث", "thāʼ", "th", "/θ/"),
  named("ج", "jīm", "j", "/dʒ/"),
  named("ح", "ḥāʼ", "ḥ", "/ħ/"),
  named("خ", "khāʼ", "kh", "/x/"),
  named("د", "dāl", "d", "/d/"),
  named("ذ", "dhāl", "dh", "/ð/"),
  named("ر", "rāʼ", "r", "/r/"),
  named("ز", "zāy", "z", "/z/"),
  named("س", "sīn", "s", "/s/"),
  named("ش", "shīn", "sh", "/ʃ/"),
  named("ص", "ṣād", "ṣ", "/sˤ/"),
  named("ض", "ḍād", "ḍ", "/dˤ/"),
  named("ط", "ṭāʼ", "ṭ", "/tˤ/"),
  named("ظ", "ẓāʼ", "ẓ", "/ðˤ/"),
  named("ع", "ʿayn", "ʿ", "/ʕ/"),
  named("غ", "ghayn", "gh", "/ɣ/"),
  named("ف", "fāʼ", "f", "/f/"),
  named("ق", "qāf", "q", "/q/"),
  named("ك", "kāf", "k", "/k/"),
  named("ل", "lām", "l", "/l/"),
  named("م", "mīm", "m", "/m/"),
  named("ن", "nūn", "n", "/n/"),
  named("ه", "hāʼ", "h", "/h/"),
  named("و", "wāw", "w / ū", "/w/, /uː/"),
  named("ي", "yāʼ", "y / ī", "/j/, /iː/"),
  named("ء", "hamza", "ʾ", "/ʔ/"),
  named("ة", "tāʼ marbūṭa", "-a / -at", "/a/, /at/; word-final"),
  named("ى", "alif maqṣūra", "ā", "/aː/; word-final"),
];
// Modern Israeli Hebrew pronunciation.
const HEBREW: Item[] = [
  named("א", "alef", "silent / ʼ", "/ʔ/ or silent"),
  named("ב", "bet", "b / v", "/b/; /v/ without dagesh (vet)"),
  named("ג", "gimel", "g", "/ɡ/"),
  named("ד", "dalet", "d", "/d/"),
  named("ה", "he", "h", "/h/; often silent at word end"),
  named("ו", "vav", "v / o / u", "/v/; vowel /o/, /u/"),
  named("ז", "zayin", "z", "/z/"),
  named("ח", "chet", "ch", "/χ/"),
  named("ט", "tet", "t", "/t/"),
  named("י", "yod", "y / i", "/j/; vowel /i/"),
  named("כ", "kaf", "k / kh", "/k/; /χ/ without dagesh (khaf)"),
  named("ל", "lamed", "l", "/l/"),
  named("מ", "mem", "m", "/m/"),
  named("נ", "nun", "n", "/n/"),
  named("ס", "samekh", "s", "/s/"),
  named("ע", "ayin", "silent / ʼ", "/ʔ/ or silent"),
  named("פ", "pe", "p / f", "/p/; /f/ without dagesh (fe)"),
  named("צ", "tsadi", "ts", "/ts/"),
  named("ק", "qof", "k", "/k/"),
  named("ר", "resh", "r", "/ʁ/"),
  named("ש", "shin", "sh / s", "/ʃ/ (shin); /s/ (sin)"),
  named("ת", "tav", "t", "/t/"),
  named("ך", "final kaf", "kh", "/χ/; word-final form of כ"),
  named("ם", "final mem", "m", "/m/; word-final form of מ"),
  named("ן", "final nun", "n", "/n/; word-final form of נ"),
  named("ף", "final pe", "f", "/f/; word-final form of פ"),
  named("ץ", "final tsadi", "ts", "/ts/; word-final form of צ"),
];

// ---------------------------------------------------------------- Devanagari
// IAST + Hindi IPA.
const DEVANAGARI: Item[] = [
  ["अ", "a", "/ə/"],
  ["आ", "ā", "/aː/"],
  ["इ", "i", "/ɪ/"],
  ["ई", "ī", "/iː/"],
  ["उ", "u", "/ʊ/"],
  ["ऊ", "ū", "/uː/"],
  ["ऋ", "ṛ", "/rɪ/ in Hindi"],
  ["ए", "e", "/eː/"],
  ["ऐ", "ai", "/ɛː/"],
  ["ओ", "o", "/oː/"],
  ["औ", "au", "/ɔː/"],
  ["अं", "aṃ", "nasal (anusvāra)"],
  ["अः", "aḥ", "breath (visarga)"],
  ["क", "ka", "/k/"],
  ["ख", "kha", "/kʰ/"],
  ["ग", "ga", "/ɡ/"],
  ["घ", "gha", "/ɡʱ/"],
  ["ङ", "ṅa", "/ŋ/"],
  ["च", "ca", "/tʃ/"],
  ["छ", "cha", "/tʃʰ/"],
  ["ज", "ja", "/dʒ/"],
  ["झ", "jha", "/dʒʱ/"],
  ["ञ", "ña", "/ɲ/"],
  ["ट", "ṭa", "/ʈ/ retroflex"],
  ["ठ", "ṭha", "/ʈʰ/ retroflex"],
  ["ड", "ḍa", "/ɖ/ retroflex"],
  ["ढ", "ḍha", "/ɖʱ/ retroflex"],
  ["ण", "ṇa", "/ɳ/ retroflex"],
  ["त", "ta", "/t̪/ dental"],
  ["थ", "tha", "/t̪ʰ/ dental"],
  ["द", "da", "/d̪/ dental"],
  ["ध", "dha", "/d̪ʱ/ dental"],
  ["न", "na", "/n/"],
  ["प", "pa", "/p/"],
  ["फ", "pha", "/pʰ/"],
  ["ब", "ba", "/b/"],
  ["भ", "bha", "/bʱ/"],
  ["म", "ma", "/m/"],
  ["य", "ya", "/j/"],
  ["र", "ra", "/r/"],
  ["ल", "la", "/l/"],
  ["व", "va", "/ʋ/"],
  ["श", "śa", "/ʃ/"],
  ["ष", "ṣa", "/ʂ/ (Hindi /ʃ/)"],
  ["स", "sa", "/s/"],
  ["ह", "ha", "/ɦ/"],
  ["क्ष", "kṣa", "/kʃ/"],
  ["त्र", "tra", "/t̪r/"],
  ["ज्ञ", "jña", "/ɡj/ in Hindi"],
].map(([t, b, r]) => ({ t, b, r }));
const MATRAS: Item[] = [
  ["का", "kā", "ा long a"],
  ["कि", "ki", "ि short i, written before"],
  ["की", "kī", "ी long i"],
  ["कु", "ku", "ु short u"],
  ["कू", "kū", "ू long u"],
  ["कृ", "kṛ", "ृ vocalic r"],
  ["के", "ke", "े e"],
  ["कै", "kai", "ै ai"],
  ["को", "ko", "ो o"],
  ["कौ", "kau", "ौ au"],
  ["कं", "kaṃ", "ं nasal"],
  ["कः", "kaḥ", "ः breath"],
  ["क्", "k", "् virāma: no vowel"],
].map(([t, b, fr]) => ({ t, b, fr }));

// ---------------------------------------------------------------- Thai
// RTGS romanization; consonant class (mid/high/low) drives the tone rules.
const th = (t: string, name: string, rom: string, cls: string, ipa: string): Item => ({
  t,
  b: `${name} — ${rom}`,
  r: `${cls} class · ${ipa}`,
  rev: name,
});
const THAI_CONSONANTS: Item[] = [
  th("ก", "ko kai", "k", "mid", "/k/"),
  th("ข", "kho khai", "kh", "high", "/kʰ/"),
  th("ฃ", "kho khuat", "kh", "high", "/kʰ/ (obsolete)"),
  th("ค", "kho khwai", "kh", "low", "/kʰ/"),
  th("ฅ", "kho khon", "kh", "low", "/kʰ/ (obsolete)"),
  th("ฆ", "kho rakhang", "kh", "low", "/kʰ/"),
  th("ง", "ngo ngu", "ng", "low", "/ŋ/"),
  th("จ", "cho chan", "ch", "mid", "/tɕ/"),
  th("ฉ", "cho ching", "ch", "high", "/tɕʰ/"),
  th("ช", "cho chang", "ch", "low", "/tɕʰ/"),
  th("ซ", "so so", "s", "low", "/s/"),
  th("ฌ", "cho choe", "ch", "low", "/tɕʰ/"),
  th("ญ", "yo ying", "y", "low", "/j/; final n"),
  th("ฎ", "do chada", "d", "mid", "/d/"),
  th("ฏ", "to patak", "t", "mid", "/t/"),
  th("ฐ", "tho than", "th", "high", "/tʰ/"),
  th("ฑ", "tho montho", "th", "low", "/tʰ/ or /d/"),
  th("ฒ", "tho phuthao", "th", "low", "/tʰ/"),
  th("ณ", "no nen", "n", "low", "/n/"),
  th("ด", "do dek", "d", "mid", "/d/"),
  th("ต", "to tao", "t", "mid", "/t/"),
  th("ถ", "tho thung", "th", "high", "/tʰ/"),
  th("ท", "tho thahan", "th", "low", "/tʰ/"),
  th("ธ", "tho thong", "th", "low", "/tʰ/"),
  th("น", "no nu", "n", "low", "/n/"),
  th("บ", "bo baimai", "b", "mid", "/b/"),
  th("ป", "po pla", "p", "mid", "/p/"),
  th("ผ", "pho phueng", "ph", "high", "/pʰ/"),
  th("ฝ", "fo fa", "f", "high", "/f/"),
  th("พ", "pho phan", "ph", "low", "/pʰ/"),
  th("ฟ", "fo fan", "f", "low", "/f/"),
  th("ภ", "pho samphao", "ph", "low", "/pʰ/"),
  th("ม", "mo ma", "m", "low", "/m/"),
  th("ย", "yo yak", "y", "low", "/j/"),
  th("ร", "ro ruea", "r", "low", "/r/; final n"),
  th("ล", "lo ling", "l", "low", "/l/; final n"),
  th("ว", "wo waen", "w", "low", "/w/"),
  th("ศ", "so sala", "s", "high", "/s/"),
  th("ษ", "so ruesi", "s", "high", "/s/"),
  th("ส", "so suea", "s", "high", "/s/"),
  th("ห", "ho hip", "h", "high", "/h/"),
  th("ฬ", "lo chula", "l", "low", "/l/"),
  th("อ", "o ang", "silent / vowel carrier", "mid", "/ʔ/"),
  th("ฮ", "ho nokhuk", "h", "low", "/h/"),
];
// ◌ marks where the consonant goes. Reverse terms are IPA (RTGS has no length).
const thv = (t: string, rom: string, ipa: string, note?: string): Item => ({
  t,
  b: rom,
  rev: ipa,
  ...(note ? { r: note } : {}),
});
const THAI_VOWELS: Item[] = [
  thv("◌ะ", "a (short)", "/a/"),
  thv("◌า", "a (long)", "/aː/"),
  thv("◌ิ", "i (short)", "/i/"),
  thv("◌ี", "i (long)", "/iː/"),
  thv("◌ึ", "ue (short)", "/ɯ/"),
  thv("◌ื", "ue (long)", "/ɯː/"),
  thv("◌ุ", "u (short)", "/u/"),
  thv("◌ู", "u (long)", "/uː/"),
  thv("เ◌ะ", "e (short)", "/e/"),
  thv("เ◌", "e (long)", "/eː/"),
  thv("แ◌ะ", "ae (short)", "/ɛ/"),
  thv("แ◌", "ae (long)", "/ɛː/"),
  thv("โ◌ะ", "o (short)", "/o/"),
  thv("โ◌", "o (long)", "/oː/"),
  thv("เ◌าะ", "o (short, open)", "/ɔ/"),
  thv("◌อ", "o (long, open)", "/ɔː/"),
  thv("เ◌อะ", "oe (short)", "/ɤ/"),
  thv("เ◌อ", "oe (long)", "/ɤː/"),
  thv("เ◌ีย", "ia", "/iːa/"),
  thv("เ◌ือ", "uea", "/ɯːa/"),
  thv("◌ัว", "ua", "/uːa/"),
  thv("◌ำ", "am", "/am/"),
  thv("ไ◌", "ai", "/aj/", "ไ (mai malai) is the common spelling"),
  thv("ใ◌", "ai", "/aj/", "ใ (mai muan) is used in ~20 words"),
  thv("เ◌า", "ao", "/aw/"),
];

// ---------------------------------------------------------------- Latin: spelling → sound
// Back is IPA; `fr` gives an example word (forward only, it contains the spelling).
const sp = (t: string, ipa: string, ex: string, r?: string): Item => ({
  t,
  b: ipa,
  fr: ex,
  ...(r ? { r } : {}),
});
const FRENCH: Item[] = [
  sp("a", "/a/", "patte"),
  sp("à", "/a/", "voilà"),
  sp("â", "/ɑ/", "pâte", "often /a/ today"),
  sp("e", "/ə/", "le, petit", "often silent at word end"),
  sp("é", "/e/", "été"),
  sp("è", "/ɛ/", "père"),
  sp("ê", "/ɛ/", "fête"),
  sp("ë", "/ɛ/", "Noël"),
  sp("i", "/i/", "lit"),
  sp("î", "/i/", "île"),
  sp("y", "/i/", "stylo"),
  sp("o", "/ɔ/", "porte", "/o/ at syllable end: mot"),
  sp("ô", "/o/", "côte"),
  sp("u", "/y/", "tu", "lips round, tongue as for i"),
  sp("û", "/y/", "sûr"),
  sp("ou", "/u/", "fou"),
  sp("oi", "/wa/", "roi"),
  sp("au", "/o/", "chaud"),
  sp("eau", "/o/", "beau"),
  sp("ai", "/ɛ/", "lait"),
  sp("ei", "/ɛ/", "neige"),
  sp("-et", "/ɛ/", "jouet"),
  sp("eu", "/ø/", "feu", "/œ/ before a pronounced consonant"),
  sp("œu", "/œ/", "cœur"),
  sp("-er", "/e/", "parler", "verb infinitive ending"),
  sp("-ez", "/e/", "nez, parlez"),
  sp("an", "/ɑ̃/", "an, chanter", "also am"),
  sp("en", "/ɑ̃/", "enfant", "also em"),
  sp("on", "/ɔ̃/", "bon", "also om"),
  sp("in", "/ɛ̃/", "vin", "also im, yn"),
  sp("ain", "/ɛ̃/", "pain", "also ein"),
  sp("un", "/œ̃/", "brun", "many speakers say /ɛ̃/"),
  sp("oin", "/wɛ̃/", "loin"),
  sp("ien", "/jɛ̃/", "bien"),
  sp("ç", "/s/", "ça, garçon"),
  sp("ce, ci", "/s/", "ici, cela"),
  sp("ca, co, cu", "/k/", "café"),
  sp("qu", "/k/", "qui"),
  sp("ge, gi", "/ʒ/", "rouge, girafe"),
  sp("j", "/ʒ/", "je"),
  sp("ch", "/ʃ/", "chat"),
  sp("gn", "/ɲ/", "montagne"),
  sp("ph", "/f/", "photo"),
  sp("th", "/t/", "thé"),
  sp("ill", "/ij/", "fille", "but /il/ in ville, mille"),
  sp("-s- between vowels", "/z/", "rose"),
  sp("-tion", "/sjɔ̃/", "nation"),
  sp("r", "/ʁ/", "rue", "in the throat"),
  sp("h", "silent", "homme, hôtel"),
];
const SPANISH: Item[] = [
  sp("a", "/a/", "casa"),
  sp("e", "/e/", "mesa"),
  sp("i", "/i/", "sí"),
  sp("o", "/o/", "foto"),
  sp("u", "/u/", "luna"),
  sp("á é í ó ú", "stressed vowel", "café, también", "accent marks stress, not a new sound"),
  sp("ñ", "/ɲ/", "año"),
  sp("ll", "/ʝ/", "calle", "/ʎ/ in some areas"),
  sp("y", "/ʝ/", "yo", "/i/ alone or at word end: y, hoy"),
  sp("r between vowels", "/ɾ/", "pero", "single tap"),
  sp("rr", "/r/", "perro", "trill"),
  sp("r- at word start", "/r/", "rojo", "trill"),
  sp("j", "/x/", "jamón"),
  sp("ge, gi", "/x/", "gente, girar"),
  sp("ga, go, gu", "/ɡ/", "gato"),
  sp("gue, gui", "/ɡ/", "guerra, guitarra", "u is silent"),
  sp("güe, güi", "/ɡw/", "pingüino"),
  sp("ca, co, cu", "/k/", "casa"),
  sp("que, qui", "/k/", "queso", "u is silent"),
  sp("ce, ci", "/θ/", "cena", "/s/ in Latin America"),
  sp("z", "/θ/", "zapato", "/s/ in Latin America"),
  sp("ch", "/tʃ/", "chico"),
  sp("h", "silent", "hola"),
  sp("b", "/b/", "bien", "/β/ between vowels"),
  sp("v", "/b/", "vino", "same as b"),
  sp("d between vowels", "/ð/", "cada"),
  sp("x", "/ks/", "examen", "/x/ in México"),
];
const GERMAN: Item[] = [
  sp("ä", "/ɛ/", "Männer", "long /ɛː/: Käse"),
  sp("ö", "/ø/", "schön", "short /œ/: können"),
  sp("ü", "/y/", "über", "short /ʏ/: Glück"),
  sp("ß", "/s/", "Straße"),
  sp("ei", "/aɪ̯/", "mein"),
  sp("ai", "/aɪ̯/", "Mai"),
  sp("ie", "/iː/", "Liebe"),
  sp("eu", "/ɔʏ̯/", "neu"),
  sp("äu", "/ɔʏ̯/", "Häuser"),
  sp("au", "/aʊ̯/", "Haus"),
  sp("sch", "/ʃ/", "Schule"),
  sp("sp- at word start", "/ʃp/", "spielen"),
  sp("st- at word start", "/ʃt/", "Stadt"),
  sp("ch after a, o, u", "/x/", "Bach, Buch"),
  sp("ch after e, i, ä, ö, ü", "/ç/", "ich, Milch"),
  sp("-ig at word end", "/ɪç/", "König"),
  sp("chs", "/ks/", "sechs"),
  sp("z", "/ts/", "Zeit"),
  sp("tz", "/ts/", "Katze"),
  sp("w", "/v/", "Wasser"),
  sp("v", "/f/", "Vater", "/v/ in loanwords: Vase"),
  sp("j", "/j/", "ja"),
  sp("s before a vowel", "/z/", "Sonne, Rose"),
  sp("qu", "/kv/", "Quelle"),
  sp("pf", "/pf/", "Apfel"),
  sp("ng", "/ŋ/", "singen", "no hard g"),
  sp("-er at word end", "/ɐ/", "Vater, besser"),
  sp("r", "/ʁ/", "rot", "in the throat"),
  sp("b d g at word end", "/p t k/", "gelb, Hund, Tag", "final devoicing"),
  sp("h after a vowel", "silent (long vowel)", "sehen, Kuh"),
];

// ---------------------------------------------------------------- lists
const LISTS: ListDef[] = [
  {
    id: "ja-hiragana",
    lang: "ja",
    name: "Japanese · Hiragana",
    level: "basic",
    source: "Modified Hepburn romanization (gojūon, dakuten/handakuten, yōon)",
    items: patch([...HIRA_GOJUON, ...HIRA_DAKUTEN, ...HIRA_YOON], KANA_FIX),
  },
  {
    id: "ja-katakana",
    lang: "ja",
    name: "Japanese · Katakana",
    level: "basic",
    source:
      "Modified Hepburn romanization (gojūon, dakuten/handakuten, yōon, extended loanword kana)",
    items: [
      ...patch(toKata([...HIRA_GOJUON, ...HIRA_DAKUTEN, ...HIRA_YOON]), kanaFixKata),
      ...KATA_EXTENDED,
    ],
  },
  {
    id: "ko-jamo",
    lang: "ko",
    name: "Korean · Hangul jamo",
    level: "basic",
    source: "Revised Romanization of Korean (2000); IPA per Korean phonology",
    items: HANGUL_JAMO,
  },
  {
    id: "ko-syllables",
    lang: "ko",
    name: "Korean · Hangul syllables (common)",
    level: "intermediate",
    source: "Revised Romanization of Korean (2000), syllables romanized in isolation",
    items: hangulCommonItems(),
  },
  {
    id: "zh-zhuyin",
    lang: "zh",
    name: "Chinese · Zhuyin (Bopomofo)",
    level: "basic",
    source: "Zhuyin Fuhao ↔ Hanyu Pinyin correspondence",
    items: ZHUYIN,
  },
  {
    id: "zh-pinyin",
    lang: "zh",
    name: "Chinese · Pinyin initials & finals",
    level: "basic",
    source: "Hanyu Pinyin; IPA per Standard Chinese phonology",
    items: PINYIN,
  },
  {
    id: "zh-syllables",
    lang: "zh",
    name: "Chinese · Pinyin syllables",
    level: "intermediate",
    source:
      "Toneless Mandarin syllables of the Table of General Standard Chinese Characters (Unihan kTGHZ2013), ordered by frequency and with example characters from Xiandai Hanyu Pinlu Cidian (Unihan kHanyuPinlu); pinyin → zhuyin by rule",
    license: UNIHAN_LICENSE,
    items: ZH.toneless,
  },
  {
    id: "zh-syllables-tones",
    lang: "zh",
    name: "Chinese · Pinyin syllables with tones",
    level: "advanced",
    source:
      "Toned syllables occurring in the ~3,800 common characters of Xiandai Hanyu Pinlu Cidian (Unihan kHanyuPinlu), example = most frequent character; neutral tone only where it is a character's main reading; pinyin → zhuyin by rule",
    license: UNIHAN_LICENSE,
    items: ZH.toned,
  },
  {
    id: "ru-cyrillic",
    lang: "ru",
    name: "Russian · Cyrillic",
    level: "basic",
    source: "BGN/PCGN romanization of Russian; IPA per Russian phonology",
    items: RUSSIAN,
  },
  {
    id: "uk-cyrillic-diff",
    lang: "uk",
    name: "Ukrainian · letters that differ from Russian",
    level: "basic",
    source: "Ukrainian National transliteration (2010); IPA per Ukrainian phonology",
    items: UKRAINIAN,
  },
  {
    id: "el-greek",
    lang: "el",
    name: "Greek · letters",
    level: "basic",
    source: "Greek alphabet letter names; ELOT 743 romanization; Modern Greek IPA",
    items: GREEK,
  },
  {
    id: "ar-letters",
    lang: "ar",
    name: "Arabic · letters",
    level: "basic",
    source: "Arabic alphabet letter names; DIN 31635 / ALA-LC transliteration; IPA",
    items: ARABIC,
  },
  {
    id: "he-letters",
    lang: "he",
    name: "Hebrew · letters",
    level: "basic",
    source: "Hebrew alphabet letter names; Modern Israeli Hebrew pronunciation (IPA)",
    items: HEBREW,
  },
  {
    id: "hi-devanagari",
    lang: "hi",
    name: "Hindi · Devanagari vowels & consonants",
    level: "basic",
    source: "IAST transliteration; Hindi IPA",
    items: DEVANAGARI,
  },
  {
    id: "hi-matras",
    lang: "hi",
    name: "Hindi · vowel signs (matras)",
    level: "intermediate",
    source: "IAST transliteration",
    items: MATRAS,
  },
  {
    id: "th-consonants",
    lang: "th",
    name: "Thai · consonants",
    level: "basic",
    source: "Thai consonant names and classes; RTGS romanization (initial position); IPA",
    items: THAI_CONSONANTS,
  },
  {
    id: "th-vowels",
    lang: "th",
    name: "Thai · vowels",
    level: "basic",
    source: "RTGS romanization; IPA per Thai phonology",
    items: THAI_VOWELS,
  },
  {
    id: "fr-spelling",
    lang: "fr",
    name: "French · sounds of spelling",
    level: "basic",
    source: "French orthography ↔ IPA (standard French)",
    items: FRENCH,
  },
  {
    id: "es-spelling",
    lang: "es",
    name: "Spanish · sounds of spelling",
    level: "basic",
    source: "Spanish orthography ↔ IPA (Peninsular, Latin American variants noted)",
    items: SPANISH,
  },
  {
    id: "de-spelling",
    lang: "de",
    name: "German · sounds of spelling",
    level: "basic",
    source: "German orthography ↔ IPA (Standard German)",
    items: GERMAN,
  },
];

// ---------------------------------------------------------------- build + validate
function build(def: ListDef): { entries: Entry[]; merges: string[] } {
  const revOf = (it: Item) => it.rev ?? it.b;
  const groups = new Map<string, Item[]>();
  for (const it of def.items) {
    const k = revOf(it);
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const entries: Entry[] = [];
  const merges: string[] = [];
  for (const it of def.items) {
    const fwdReading = [it.fr, it.r].filter(Boolean).join(" · ");
    entries.push({ term: it.t, back: it.b, ...(fwdReading ? { reading: fwdReading } : {}) });
    const k = revOf(it);
    const g = groups.get(k)!;
    if (g[g.length - 1] !== it) continue; // reverse goes after the last member
    if (g.length > 1) merges.push(`${k} → ${g.map((x) => x.t).join(" / ")}`);
    const r = g.length === 1 ? it.r : undefined; // a merged card's hints would differ
    entries.push({ term: k, back: g.map((x) => x.t).join(" / "), ...(r ? { reading: r } : {}) });
  }

  // validation
  const seen = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!e.term || !e.back) throw new Error(`${def.id}: empty field at ${i}`);
    if (e.term !== e.term.trim()) throw new Error(`${def.id}: untrimmed term "${e.term}"`);
    if (seen.has(e.term)) throw new Error(`${def.id}: duplicate term "${e.term}"`);
    seen.set(e.term, i);
  });
  for (const it of def.items) {
    const rev = entries.find((e) => e.term === revOf(it));
    if (!rev || !rev.back.split(" / ").includes(it.t))
      throw new Error(`${def.id}: no reverse card for "${it.t}"`);
    // the reverse front must not contain its own answer
    if (/[^\u0020-\u036f]/.test(it.t) && revOf(it).includes(it.t))
      throw new Error(`${def.id}: reverse "${revOf(it)}" reveals "${it.t}"`);
  }
  return { entries, merges };
}

const outDir = args[0] ?? "public/alphabets";
mkdirSync(outDir, { recursive: true });
const ids = new Set<string>();
const index: Record<string, unknown>[] = [];
let total = 0;
for (const def of LISTS) {
  if (ids.has(def.id)) throw new Error(`duplicate list id ${def.id}`);
  ids.add(def.id);
  const { entries, merges } = build(def);
  const file = `${def.id}.json`;
  const body = JSON.stringify({
    id: def.id,
    lang: def.lang,
    name: def.name,
    level: def.level,
    source: def.source,
    license: def.license ?? LICENSE,
    entries,
  });
  writeFileSync(join(outDir, file), body + "\n");
  total += body.length + 1;
  index.push({
    id: def.id,
    lang: def.lang,
    name: def.name,
    level: def.level,
    source: def.source,
    license: def.license ?? LICENSE,
    count: entries.length,
    file,
  });
  console.log(
    `${def.id.padEnd(18)} ${String(def.items.length).padStart(4)} symbols ${String(entries.length).padStart(4)} cards` +
      (merges.length ? `  merged: ${merges.join("; ")}` : ""),
  );
}
const indexBody = JSON.stringify({ lists: index });
writeFileSync(join(outDir, "index.json"), indexBody + "\n");
console.log(`${LISTS.length} lists, ${(total / 1024).toFixed(1)} KiB of list files`);
