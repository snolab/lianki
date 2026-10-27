# Alphabet drill sources and licenses

Data for the `/alphabet` pronunciation drill. Each list file also has its own
`source` and `license` fields. Every list is bidirectional: a symbol → sound
card is followed by its sound → symbol card. When several symbols share one
reading (じ / ぢ = "ji"), they share one reverse card whose back lists them all.

## Rebuild

```bash
bun scripts/alphabets/build-alphabets.ts [out-dir] [--unihan path/to/Unihan_Readings.txt]
```

The script writes into `public/alphabets` by default. It checks that terms are
unique within each list and that every forward card has a reverse. Without
`--unihan` it downloads `Unihan.zip` from unicode.org into the OS temp dir,
caches it there, and extracts it with `unzip`.

## Hand-written tables (CC0)

Romanization and IPA correspondences are facts from published standards. They
were typed by hand into `scripts/alphabets/build-alphabets.ts`, and no
third-party text or card designs were copied. License: CC0 (factual tables).

| List                         | Standard                                                                              | Reference                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ja-hiragana`, `ja-katakana` | Modified Hepburn                                                                      | [Hepburn romanization](https://en.wikipedia.org/wiki/Hepburn_romanization), [Hiragana](https://en.wikipedia.org/wiki/Hiragana), [Katakana](https://en.wikipedia.org/wiki/Katakana)                                           |
| `ko-jamo`, `ko-syllables`    | Revised Romanization of Korean (2000); syllables romanized by rule, read in isolation | [Revised Romanization of Korean](https://en.wikipedia.org/wiki/Revised_Romanization_of_Korean), [Korean phonology](https://en.wikipedia.org/wiki/Korean_phonology)                                                           |
| `zh-zhuyin`, `zh-pinyin`     | Zhuyin Fuhao, Hanyu Pinyin                                                            | [Bopomofo](https://en.wikipedia.org/wiki/Bopomofo), [Pinyin](https://en.wikipedia.org/wiki/Pinyin), [Standard Chinese phonology](https://en.wikipedia.org/wiki/Standard_Chinese_phonology)                                   |
| `ru-cyrillic`                | BGN/PCGN                                                                              | [Romanization of Russian](https://en.wikipedia.org/wiki/Romanization_of_Russian), [Russian alphabet](https://en.wikipedia.org/wiki/Russian_alphabet)                                                                         |
| `uk-cyrillic-diff`           | Ukrainian National transliteration (2010)                                             | [Romanization of Ukrainian](https://en.wikipedia.org/wiki/Romanization_of_Ukrainian), [Ukrainian alphabet](https://en.wikipedia.org/wiki/Ukrainian_alphabet)                                                                 |
| `el-greek`                   | ELOT 743; Modern Greek pronunciation                                                  | [Greek alphabet](https://en.wikipedia.org/wiki/Greek_alphabet), [Romanization of Greek](https://en.wikipedia.org/wiki/Romanization_of_Greek)                                                                                 |
| `ar-letters`                 | DIN 31635 / ALA-LC                                                                    | [Arabic alphabet](https://en.wikipedia.org/wiki/Arabic_alphabet), [Romanization of Arabic](https://en.wikipedia.org/wiki/Romanization_of_Arabic)                                                                             |
| `he-letters`                 | Modern Israeli Hebrew pronunciation                                                   | [Hebrew alphabet](https://en.wikipedia.org/wiki/Hebrew_alphabet), [Modern Hebrew phonology](https://en.wikipedia.org/wiki/Modern_Hebrew_phonology)                                                                           |
| `hi-devanagari`, `hi-matras` | IAST                                                                                  | [IAST](https://en.wikipedia.org/wiki/International_Alphabet_of_Sanskrit_Transliteration), [Devanagari](https://en.wikipedia.org/wiki/Devanagari), [Hindustani phonology](https://en.wikipedia.org/wiki/Hindustani_phonology) |
| `th-consonants`, `th-vowels` | Royal Thai General System of Transcription (RTGS)                                     | [RTGS](https://en.wikipedia.org/wiki/Royal_Thai_General_System_of_Transcription), [Thai script](https://en.wikipedia.org/wiki/Thai_script)                                                                                   |
| `fr-spelling`                | IPA                                                                                   | [French orthography](https://en.wikipedia.org/wiki/French_orthography), [Help:IPA/French](https://en.wikipedia.org/wiki/Help:IPA/French)                                                                                     |
| `es-spelling`                | IPA                                                                                   | [Spanish orthography](https://en.wikipedia.org/wiki/Spanish_orthography), [Help:IPA/Spanish](https://en.wikipedia.org/wiki/Help:IPA/Spanish)                                                                                 |
| `de-spelling`                | IPA                                                                                   | [German orthography](https://en.wikipedia.org/wiki/German_orthography), [Help:IPA/Standard German](https://en.wikipedia.org/wiki/Help:IPA/Standard_German)                                                                   |

## Mandarin syllables (`zh-syllables`, `zh-syllables-tones`)

These lists come from the [Unicode Unihan database](https://www.unicode.org/charts/unihan.html)
(`Unihan_Readings.txt`), under the [Unicode License v3](https://www.unicode.org/license.txt).
The pinyin → zhuyin conversion is rule-based and lives in
`scripts/alphabets/zh-syllables.ts` (CC0).

- **`kTGHZ2013`**: readings of the 8,105 characters in the Table of General
  Standard Chinese Characters (通用规范汉字表, 2013). This decides which
  toneless syllables are standard. Interjection-only readings (m, n, ng, hm,
  hng, toned ê) and the erhua `r` are skipped.
- **`kHanyuPinlu`**: reading frequencies from 《现代汉语频率词典》(Xiandai
  Hanyu Pinlu Cidian) for about 3,800 common characters. It sets the
  frequency order, which toned syllables appear in the toned list, and the
  example characters. A character counts for a reading only if the 2013 table
  also lists that reading for it. That rule drops traditional forms and neutral
  tones that only occur inside compounds (识 in 知识). Real neutral-tone
  readings stay (的 de, 了 le, 吗 ma, 们 men).
- Example characters are the most frequent characters that take the reading as
  their main reading. Syllables missing from the frequency data use the first
  characters listed in the 2013 table.
