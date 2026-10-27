/**
 * Just enough Korean morphology for the word lists: subtitle tokens are
 * eojeol — a stem with its particles or endings attached (사람이, 팔고, 할게)
 * — while Wiktionary is keyed by the noun or the dictionary form (사람,
 * 팔다). These helpers map a token back to candidate dictionary words; the
 * builder only accepts a candidate that has its own Wiktionary entry.
 */

const BASE = 0xac00;
const isSyllable = (c: string) => {
  const n = c.charCodeAt(0) - BASE;
  return n >= 0 && n < 11172;
};
/** Final-consonant index of a syllable (0 = none). */
export const batchim = (c: string) => (isSyllable(c) ? (c.charCodeAt(0) - BASE) % 28 : -1);
/** Replace the final consonant of the last syllable: 하 + ㄹ(8) → 할. */
function withFinal(s: string, t: number): string {
  const c = s.at(-1)!;
  if (!isSyllable(c)) return "";
  const n = c.charCodeAt(0) - BASE;
  return s.slice(0, -1) + String.fromCharCode(BASE + n - (n % 28) + t);
}
const T_N = 4; // ㄴ
const T_L = 8; // ㄹ
const T_SS = 20; // ㅆ

/** Endings that attach to the bare stem with no sound change. */
const STEM_ENDINGS =
  "고 고요 지 지요 죠 지만 지도 게 게요 기 기로 기는 기도 네 네요 는 는데 는데요 는지 는군 는구나 니 냐 냐고 겠 겠어 겠어요 겠다 겠지 겠네 겠습니다 잖아 잖아요 거든 거든요 더라 더니 던 도록 자 자고 군 구나 군요 다고 다는 다면 대 대요 래 래요".split(
    " ",
  );
/** After the future determiner (할, 갈, 먹을); 께 is the common subtitle spelling of -ㄹ게 (할께). */
const FUT_ENDINGS =
  "게 게요 께 께요 까 까요 래 래요 거야 거예요 거지 거죠 건데 걸 걸요 지도 텐데 테니까 수록 때".split(
    " ",
  );
/** After the infinitive (해, 가, 봐, 먹어). */
const INF_ENDINGS =
  "요 서 서요 도 야 야지 야겠어 줘 줘요 주세요 줄게 줄래 봐 봐요 버렸어 버려 라 졌어 져 있어 있어요 놔 왔어 갔어".split(
    " ",
  );
/** After the past stem (했, 갔, 먹었). */
const PAST_ENDINGS =
  "어 어요 다 지 지만 지요 죠 고 는데 는데요 니 냐 네 네요 잖아 잖아요 을 을까 던 겠 겠지 군 구나 거든 다고 다면 대 습니다 습니까 어서".split(
    " ",
  );

/**
 * Forms of a verb/adjective: its conjugation-table forms plus regular
 * combinations built from the stem, the infinitive and the past stem.
 * Unattested or wrong guesses are harmless — only forms that occur as
 * tokens are ever looked up.
 */
export function verbForms(lemma: string, table: string[]): string[] {
  if (!lemma.endsWith("다") || lemma.length < 2) return table;
  const stem = lemma.slice(0, -1);
  const out = new Set(table);
  for (const e of STEM_ENDINGS) out.add(stem + e);
  const last = stem.at(-1)!;
  const b = batchim(last);
  const fut = b === 0 ? withFinal(stem, T_L) : b === T_L ? stem : stem + "을";
  const det = b === 0 ? withFinal(stem, T_N) : stem + "은";
  if (fut) {
    out.add(fut);
    for (const e of FUT_ENDINGS) out.add(fut + e);
  }
  if (det) out.add(det);
  // infinitive: the shortest table form X with X+요 also in the table (해/해요)
  const tset = new Set(table);
  const inf = table
    .filter((f) => tset.has(f + "요") && !/[시셔셨]/.test(f))
    .sort((a, c) => a.length - c.length)[0];
  if (inf) {
    for (const e of INF_ENDINGS) out.add(inf + e);
    const past = batchim(inf.at(-1)!) === 0 ? withFinal(inf, T_SS) : "";
    if (past) for (const e of PAST_ENDINGS) out.add(past + e);
  }
  out.delete(lemma);
  return [...out];
}

/**
 * Particles and copula endings by what they follow: after a consonant
 * (사람이, 책을, 집이야) or after a vowel (나가, 너를, 거야). Longest first.
 */
const AFTER_CONSONANT = (
  "에서는 에서도 에게는 한테는 으로는 이라도 이라고 이라는 이었어 이었다 이에요 입니다 입니까 이니까 " +
  "에서 에게 한테 께서 으로 이랑 까지 부터 처럼 보다 마다 밖에 이나 이란 이야 이지 이죠 인데 이다 이냐 이니 이고 이요 " +
  "이 은 을 의 에 께 도 만 과 아"
).split(" ");
const AFTER_VOWEL = (
  "에서는 에서도 에게는 한테는 라도 라고 라는 였어 였다 예요 입니다 " +
  "에서 에게 한테 께서 까지 부터 처럼 보다 마다 밖에 로는 " +
  "가 는 를 의 에 께 도 만 로 와 랑 나 요 야 란 지 죠 다 냐 니 고"
).split(" ");

/** Noun + particle / copula splits of a token: 사람이 → 사람, 거야 → 거. */
export function stripParticles(token: string): string[] {
  const out: string[] = [];
  for (const [list, wantFinal] of [
    [AFTER_CONSONANT, true],
    [AFTER_VOWEL, false],
  ] as const) {
    for (const p of list) {
      if (token.length <= p.length || !token.endsWith(p)) continue;
      const stem = token.slice(0, -p.length);
      const b = batchim(stem.at(-1)!);
      // 로/으로 also follow ㄹ (길로)
      if (wantFinal ? b > 0 : b === 0 || (b === T_L && p.startsWith("로"))) out.push(stem);
    }
  }
  return out;
}

/** 난 → 나, 널 → 너, 건 → 거: a topic/object particle fused into a vowel-final word. */
export function unfuse(token: string): string {
  const b = batchim(token.at(-1)!);
  return b === T_N || b === T_L ? withFinal(token, 0) : "";
}

/** Particles that show a token is used as a noun (해가, 해를 …). */
export const NOUN_EVIDENCE = "이 가 은 는 을 를 의 에서".split(" ");
