/** opencc-js (MIT, nk2028) ships no types; only the converter the word-list builders use. */
declare module "opencc-js" {
  export function Converter(opts: { from: string; to: string }): (text: string) => string;
}
