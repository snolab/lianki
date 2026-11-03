/** CC-CEDICT numbered pinyin ("ni3 hao3", "lu:4") → tone marks ("nǐ hǎo", "lǜ"). */
export function markPinyin(numbered: string): string {
  const MARKS: Record<string, string> = {
    a: "āáǎà",
    e: "ēéěè",
    i: "īíǐì",
    o: "ōóǒò",
    u: "ūúǔù",
    ü: "ǖǘǚǜ",
  };
  return numbered
    .split(" ")
    .map((syl0) => {
      const m = /^([a-zü:]+)([1-5])$/i.exec(syl0);
      if (!m) return syl0.replace(/u:/g, "ü");
      const syl = m[1].replace(/u:/gi, "ü");
      const tone = Number(m[2]);
      if (tone === 5) return syl;
      const lower = syl.toLowerCase();
      let at = lower.search(/[ae]/);
      if (at < 0) at = lower.indexOf("ou");
      if (at < 0) {
        const vs = [...lower.matchAll(/[aeiouü]/g)];
        at = vs.length ? vs[vs.length - 1].index! : -1;
      }
      if (at < 0) return syl;
      const v = lower[at];
      const mark = MARKS[v][tone - 1];
      return syl.slice(0, at) + (syl[at] === v ? mark : mark.toUpperCase()) + syl.slice(at + 1);
    })
    .join(" ");
}
