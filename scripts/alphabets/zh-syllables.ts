/**
 * Mandarin syllable lists (pinyin ↔ zhuyin) for build-alphabets.ts.
 *
 * Source data: Unicode Unihan database, Unihan_Readings.txt
 *   - kTGHZ2013   readings of the 8,105 characters of the Table of General
 *                 Standard Chinese Characters (通用规范汉字表, 2013): defines
 *                 which toneless syllables exist in standard Mandarin.
 *   - kHanyuPinlu reading frequencies from 《现代汉语频率词典》(Xiandai Hanyu
 *                 Pinlu Cidian): ~3,800 common characters. Gives syllable
 *                 frequency (ordering), the toned syllables that occur in
 *                 common characters, and the example characters.
 * The pinyin → zhuyin conversion is rule-based (standard correspondence).
 */
import { readFileSync } from "node:fs";

type Item = { t: string; b: string; r?: string; fr?: string; rev?: string };

const TONE_MARKS: Record<string, [string, number]> = {};
for (const [base, marks] of [
  ["a", "āáǎà"],
  ["e", "ēéěè"],
  ["i", "īíǐì"],
  ["o", "ōóǒò"],
  ["u", "ūúǔù"],
  ["ü", "ǖǘǚǜ"],
] as const)
  [...marks].forEach((m, i) => (TONE_MARKS[m] = [base, i + 1]));

/** "zhōng" → ["zhong", 1]; neutral tone → 5. */
export function splitTone(p: string): [string, number] {
  let tone = 5;
  let base = "";
  for (const c of p.normalize("NFC")) {
    const m = TONE_MARKS[c];
    if (m) {
      base += m[0];
      tone = m[1];
    } else base += c;
  }
  return [base, tone];
}

const INITIALS: [string, string][] = [
  ["zh", "ㄓ"],
  ["ch", "ㄔ"],
  ["sh", "ㄕ"],
  ["b", "ㄅ"],
  ["p", "ㄆ"],
  ["m", "ㄇ"],
  ["f", "ㄈ"],
  ["d", "ㄉ"],
  ["t", "ㄊ"],
  ["n", "ㄋ"],
  ["l", "ㄌ"],
  ["g", "ㄍ"],
  ["k", "ㄎ"],
  ["h", "ㄏ"],
  ["j", "ㄐ"],
  ["q", "ㄑ"],
  ["x", "ㄒ"],
  ["r", "ㄖ"],
  ["z", "ㄗ"],
  ["c", "ㄘ"],
  ["s", "ㄙ"],
];
const FINALS: Record<string, string> = {
  a: "ㄚ",
  o: "ㄛ",
  e: "ㄜ",
  ê: "ㄝ",
  ai: "ㄞ",
  ei: "ㄟ",
  ao: "ㄠ",
  ou: "ㄡ",
  an: "ㄢ",
  en: "ㄣ",
  ang: "ㄤ",
  eng: "ㄥ",
  er: "ㄦ",
  ong: "ㄨㄥ",
  i: "ㄧ",
  ia: "ㄧㄚ",
  io: "ㄧㄛ",
  ie: "ㄧㄝ",
  iao: "ㄧㄠ",
  iu: "ㄧㄡ",
  ian: "ㄧㄢ",
  in: "ㄧㄣ",
  iang: "ㄧㄤ",
  ing: "ㄧㄥ",
  iong: "ㄩㄥ",
  u: "ㄨ",
  ua: "ㄨㄚ",
  uo: "ㄨㄛ",
  uai: "ㄨㄞ",
  ui: "ㄨㄟ",
  uan: "ㄨㄢ",
  un: "ㄨㄣ",
  uang: "ㄨㄤ",
  ueng: "ㄨㄥ",
  ü: "ㄩ",
  üe: "ㄩㄝ",
  üan: "ㄩㄢ",
  ün: "ㄩㄣ",
};
// Zero-initial spellings with y- / w-.
const Y_W: Record<string, string> = {
  yi: "i",
  ya: "ia",
  yo: "io",
  ye: "ie",
  yao: "iao",
  you: "iu",
  yan: "ian",
  yin: "in",
  yang: "iang",
  ying: "ing",
  yong: "iong",
  yu: "ü",
  yue: "üe",
  yuan: "üan",
  yun: "ün",
  wu: "u",
  wa: "ua",
  wo: "uo",
  wai: "uai",
  wei: "ui",
  wan: "uan",
  wen: "un",
  wang: "uang",
  weng: "ueng",
};
const TONE_ZHUYIN = ["", "", "ˊ", "ˇ", "ˋ"];

/** Toneless pinyin → zhuyin, or null if it is not a standard syllable. */
export function toZhuyin(base: string): string | null {
  if (Y_W[base]) return FINALS[Y_W[base]];
  if (FINALS[base] && !/^[iuü]|^ong$/.test(base)) return FINALS[base]; // a, o, e, ê, ai, er…
  const ini = INITIALS.find(([p]) => base.startsWith(p));
  if (!ini) return null;
  let fin = base.slice(ini[0].length);
  if (!fin) return null;
  if (/^[zcs]h?$|^r$/.test(ini[0]) && fin === "i") return ini[1]; // zhi chi shi ri zi ci si
  if (/^[jqx]$/.test(ini[0])) {
    if (fin.startsWith("u")) fin = "ü" + fin.slice(1); // ju = jü
    if (!/^[iü]/.test(fin)) return null;
  }
  if (fin === "ue") fin = "üe"; // nue/lue spellings
  const z = FINALS[fin];
  return z ? ini[1] + z : null;
}

export function zhuyinWithTone(base: string, tone: number): string | null {
  const z = toZhuyin(base);
  if (!z) return null;
  return tone === 5 ? "˙" + z : z + TONE_ZHUYIN[tone];
}

export function buildZhSyllables(readingsPath: string): {
  toneless: Item[];
  toned: Item[];
  skipped: string[];
} {
  const text = readFileSync(readingsPath, "utf8");
  const pinlu = new Map<string, { c: string; f: number }[]>(); // toned reading → chars
  const charTop = new Map<string, string>(); // char → its most frequent reading
  const standard = new Map<string, string[]>(); // toneless → TGHZ chars
  const tghz = new Map<string, Set<string>>(); // TGHZ char → its toned readings
  for (const line of text.split("\n")) {
    const [cp, field, value] = line.split("\t");
    if (!value) continue;
    const ch = String.fromCodePoint(parseInt(cp.slice(2), 16));
    if (field === "kHanyuPinlu") {
      let best = -1;
      for (const m of value.matchAll(/([^\s(]+)\((\d+)\)/g)) {
        const f = Number(m[2]);
        const list = pinlu.get(m[1]) ?? [];
        list.push({ c: ch, f });
        pinlu.set(m[1], list);
        if (f > best) {
          best = f;
          charTop.set(ch, m[1]);
        }
      }
    } else if (field === "kTGHZ2013") {
      const set = new Set<string>();
      for (const m of value.matchAll(/:(\S+)/g)) {
        set.add(m[1]);
        const [base] = splitTone(m[1]);
        const list = standard.get(base) ?? [];
        if (!list.includes(ch)) list.push(ch);
        standard.set(base, list);
      }
      tghz.set(ch, set);
    }
  }

  const skipped = new Set<string>();
  // toned readings that occur in common characters
  type Toned = {
    base: string;
    tone: number;
    reading: string;
    chars: { c: string; f: number }[];
    freq: number;
  };
  const toned: Toned[] = [];
  for (const [reading, chars] of pinlu) {
    const [base, tone] = splitTone(reading);
    if (!toZhuyin(base)) {
      skipped.add(reading);
      continue;
    }
    // Keep only characters of the standard (simplified) table that list this
    // reading there. That drops traditional forms in the frequency data and
    // compound-only neutral tones (识 in 知识), while keeping real neutral
    // readings (的 de, 了 le, 吗 ma, 们 men…).
    const keep = chars.filter((x) => tghz.get(x.c)?.has(reading));
    if (!keep.length) continue;
    // examples: characters whose main reading this is come first
    const main = (x: { c: string }) => (charTop.get(x.c) === reading ? 1 : 0);
    keep.sort((a, b) => main(b) - main(a) || b.f - a.f);
    toned.push({ base, tone, reading, chars: keep, freq: keep.reduce((s, x) => s + x.f, 0) });
  }

  // toneless syllables: TGHZ standard set ∪ pinlu set
  const bases = new Map<string, { freq: number; chars: Map<string, number> }>();
  for (const t of toned) {
    const b = bases.get(t.base) ?? { freq: 0, chars: new Map() };
    b.freq += t.freq;
    for (const x of t.chars) b.chars.set(x.c, (b.chars.get(x.c) ?? 0) + x.f);
    bases.set(t.base, b);
  }
  for (const base of standard.keys()) {
    if (!toZhuyin(base)) {
      skipped.add(base);
      continue;
    }
    if (!bases.has(base)) bases.set(base, { freq: 0, chars: new Map() });
  }
  const order = [...bases.entries()].sort(
    (a, b) => b[1].freq - a[1].freq || a[0].localeCompare(b[0]),
  );
  const rank = new Map(order.map(([b], i) => [b, i]));

  const tonelessItems: Item[] = order.map(([base, v]) => {
    const isMain = (c: string) => (splitTone(charTop.get(c) ?? "")[0] === base ? 1 : 0);
    let ex = [...v.chars.entries()]
      .sort((a, b) => isMain(b[0]) - isMain(a[0]) || b[1] - a[1])
      .map(([c]) => c)
      .slice(0, 2);
    if (!ex.length) ex = (standard.get(base) ?? []).slice(0, 2); // rare syllable
    return { t: base, b: toZhuyin(base)!, ...(ex.length ? { r: ex.join(" ") } : {}) };
  });
  toned.sort((a, b) => rank.get(a.base)! - rank.get(b.base)! || a.tone - b.tone);
  const tonedItems: Item[] = toned.map((t) => ({
    t: t.reading,
    b: zhuyinWithTone(t.base, t.tone)!,
    r: t.chars[0].c,
  }));
  return { toneless: tonelessItems, toned: tonedItems, skipped: [...skipped].sort() };
}
