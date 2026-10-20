/**
 * Ranks languages by the wealthiest big cities you can work in with them.
 *
 *   bun scripts/blog-data/city-language-value.ts
 *
 * Input:  blog/data/city-language-value/cities-1m.csv — every urban centre
 *         with 1M+ people in 2020 from the GHS Urban Centre Database R2024A
 *         V1.2 (JRC, CC BY 4.0): population (GH_POP_TOT_2020) and GDP at PPP
 *         (SC_GDP_SUM_2020, downscaled from Kummu et al.).
 * Output: blog/data/city-language-value/{cities-ranked,languages-top100,
 *         languages-top200}.csv, plus the tables for the blog post on stdout.
 *
 * Feeds blog/en/2026-10-21-languages-by-city-wealth.md.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dir, "../../blog/data/city-language-value");

/**
 * The UCDB's downscaled GDP puts every UK city at roughly half the OECD's
 * figure (London $38k vs $72k) while other countries agree within ~10%, so UK
 * cities use the OECD functional-urban-area GDP per head for 2020 instead
 * (OECD Regions and Cities database, DSD_FUA_ECO@DF_ECONOMY, USD PPP).
 */
const GDP_PER_HEAD_OVERRIDE: Record<string, number> = {
  London: 72186,
  Manchester: 45973,
  Leeds: 40459,
  Liverpool: 36742,
  Birmingham: 37613, // OECD "West Midlands urban area"
};

/** Main language(s) of daily life and work, by country. */
const COUNTRY: Record<string, string[]> = {
  Afghanistan: ["Dari", "Pashto"],
  Algeria: ["Arabic"],
  Angola: ["Portuguese"],
  Argentina: ["Spanish"],
  Armenia: ["Armenian"],
  Australia: ["English"],
  Austria: ["German"],
  Azerbaijan: ["Azerbaijani"],
  Bahrain: ["Arabic", "English"],
  Bangladesh: ["Bengali"],
  Belarus: ["Russian", "Belarusian"],
  Belgium: ["Dutch"],
  Benin: ["French"],
  Bolivia: ["Spanish"],
  Brazil: ["Portuguese"],
  Bulgaria: ["Bulgarian"],
  "Burkina Faso": ["French"],
  Burundi: ["Kirundi", "French"],
  Cambodia: ["Khmer"],
  Cameroon: ["French"],
  Canada: ["English"],
  "Central African Republic": ["French", "Sango"],
  Chad: ["French", "Arabic"],
  Chile: ["Spanish"],
  China: ["Chinese"],
  Colombia: ["Spanish"],
  "Costa Rica": ["Spanish"],
  "Côte d'Ivoire": ["French"],
  Cuba: ["Spanish"],
  Czechia: ["Czech"],
  "Democratic Republic of the Congo": ["French", "Lingala"],
  Denmark: ["Danish"],
  "Dominican Republic": ["Spanish"],
  Ecuador: ["Spanish"],
  Egypt: ["Arabic"],
  "El Salvador": ["Spanish"],
  Ethiopia: ["Amharic"],
  France: ["French"],
  Gambia: ["English"],
  Germany: ["German"],
  Ghana: ["English"],
  Greece: ["Greek"],
  Guatemala: ["Spanish"],
  Guinea: ["French"],
  Haiti: ["Haitian Creole", "French"],
  Honduras: ["Spanish"],
  Hungary: ["Hungarian"],
  India: ["English"], // plus the state language, below
  Indonesia: ["Indonesian"],
  Iran: ["Persian"],
  Iraq: ["Arabic"],
  Ireland: ["English"],
  Israel: ["Hebrew"],
  Italy: ["Italian"],
  Japan: ["Japanese"],
  Jordan: ["Arabic"],
  Kazakhstan: ["Kazakh", "Russian"],
  Kenya: ["English", "Swahili"],
  Kuwait: ["Arabic", "English"],
  Kyrgyzstan: ["Kyrgyz", "Russian"],
  Lebanon: ["Arabic"],
  Liberia: ["English"],
  Libya: ["Arabic"],
  Madagascar: ["Malagasy", "French"],
  Malaysia: ["Malay", "English"],
  Mali: ["French"],
  Mauritania: ["Arabic"],
  México: ["Spanish"],
  Mongolia: ["Mongolian"],
  Morocco: ["Arabic"],
  Mozambique: ["Portuguese"],
  Myanmar: ["Burmese"],
  Nepal: ["Nepali"],
  Netherlands: ["Dutch"],
  "New Zealand": ["English"],
  Nicaragua: ["Spanish"],
  Niger: ["French"],
  Nigeria: ["English"],
  "North Korea": ["Korean"],
  Pakistan: ["Urdu", "English"],
  Panama: ["Spanish"],
  Paraguay: ["Spanish", "Guarani"],
  Peru: ["Spanish"],
  Philippines: ["Filipino", "English"],
  Poland: ["Polish"],
  Portugal: ["Portuguese"],
  Qatar: ["Arabic", "English"],
  "Republic of the Congo": ["French"],
  Romania: ["Romanian"],
  Russia: ["Russian"],
  Rwanda: ["Kinyarwanda", "English", "French"],
  "Saudi Arabia": ["Arabic"],
  Senegal: ["French"],
  Serbia: ["Serbian"],
  "Sierra Leone": ["English"],
  Singapore: ["English", "Chinese", "Malay", "Tamil"],
  Somalia: ["Somali"],
  "South Africa": ["English"],
  "South Korea": ["Korean"],
  Spain: ["Spanish"],
  "Sri Lanka": ["Sinhala", "Tamil"],
  Sudan: ["Arabic"],
  Sweden: ["Swedish"],
  Syria: ["Arabic"],
  Taiwan: ["Chinese"],
  Tajikistan: ["Tajik"],
  Tanzania: ["Swahili", "English"],
  Thailand: ["Thai"],
  Togo: ["French"],
  Tunisia: ["Arabic"],
  Turkey: ["Turkish"],
  Uganda: ["English"],
  Ukraine: ["Ukrainian"],
  "United Arab Emirates": ["Arabic", "English"],
  "United Kingdom": ["English"],
  "United States": ["English"],
  Uruguay: ["Spanish"],
  Uzbekistan: ["Uzbek"],
  Venezuela: ["Spanish"],
  Vietnam: ["Vietnamese"],
  Yemen: ["Arabic"],
  Zambia: ["English"],
  Zimbabwe: ["English"],
};

/**
 * Bilingual cities, and cities whose language differs from the country's.
 * Every language listed is counted in full — a city is not split between them,
 * because someone who speaks either one can live and work there.
 */
const CITY: Record<string, string[]> = {
  "Canada/Montreal": ["French", "English"],
  "Belgium/Brussels": ["French", "Dutch"],
  "Spain/Barcelona": ["Spanish", "Catalan"],
  "Spain/Valencia": ["Spanish", "Catalan"],
  "United States/Miami": ["English", "Spanish"],
  "China/Hong Kong": ["Chinese", "English"],
  "China/Tuen Mun": ["Chinese", "English"], // the UCDB's second Hong Kong centre
  "South Africa/Cape Town": ["English", "Afrikaans", "Xhosa"],
  "South Africa/Johannesburg": ["English", "Zulu"],
  "South Africa/Durban": ["English", "Zulu"],
  "South Africa/Pretoria": ["English", "Afrikaans"],
  "South Africa/Soshanguve": ["English", "Afrikaans"],
};

/** Indian cities: English plus the state's official language. */
const INDIA_STATE_LANGUAGE: Record<string, string[]> = {
  Telugu: ["Hyderabad", "Vijayawada", "Visakhapatnam"],
  Marathi: [
    "Mumbai",
    "Kalyan-Dombivli",
    "Vasai-Virar",
    "Nagpur",
    "Pune",
    "Nashik",
    "Chhatrapati Sambhajinagar",
    "Solapur",
  ],
  Kannada: ["Bengaluru", "Mysuru"],
  Gujarati: ["Surat", "Ahmedabad", "Vadodara", "Rajkot"],
  Tamil: ["Tiruchirappalli", "Chennai", "Coimbatore", "Madurai", "Salem", "Tiruppur"],
  Punjabi: ["Jalandhar", "Ludhiana", "Amritsar"],
  Malayalam: ["Thiruvananthapuram", "Kozhikode", "Kochi", "Ponnani", "Kollam", "Thrissur"],
  Bengali: ["Kolkata", "Asansol", "Tamluk", "Berhampore", "Dhulian"],
  Assamese: ["Guwahati"],
  Odia: ["Bhubaneshwar"],
  Urdu: ["Hyderabad", "Srinagar", "Jammu"],
  Kashmiri: ["Srinagar"],
  Dogri: ["Jammu"],
};

type City = {
  id: string;
  city: string;
  country: string;
  population: number;
  gdpPerHead: number;
  languages: string[];
};

function languagesFor(city: string, country: string): string[] {
  const override = CITY[`${country}/${city}`];
  if (override) return override;
  const base = COUNTRY[country];
  if (!base) throw new Error(`no language for country "${country}" (${city})`);
  if (country !== "India") return base;
  const state = Object.entries(INDIA_STATE_LANGUAGE)
    .filter(([, cities]) => cities.includes(city))
    .map(([lang]) => lang);
  // Cities not listed above are in the Hindi-speaking states.
  return [...base, ...(state.length ? state : ["Hindi"])];
}

function parseCsv(path: string): string[][] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(","));
}

function load(): City[] {
  return parseCsv(join(DIR, "cities-1m.csv"))
    .map(([id, city, country, pop, gdp]) => {
      const population = Number(pop);
      return {
        id: id!,
        city: city!,
        country: country!,
        population,
        gdpPerHead:
          country === "United Kingdom" && GDP_PER_HEAD_OVERRIDE[city!]
            ? GDP_PER_HEAD_OVERRIDE[city!]!
            : Number(gdp) / population,
        languages: languagesFor(city!, country!),
      };
    })
    .sort((a, b) => b.gdpPerHead - a.gdpPerHead);
}

type LanguageRow = { language: string; cities: number; population: number; examples: string[] };

function rankLanguages(cities: City[]): LanguageRow[] {
  const by = new Map<string, LanguageRow>();
  for (const c of cities) {
    for (const language of c.languages) {
      const row = by.get(language) ?? { language, cities: 0, population: 0, examples: [] };
      row.cities++;
      row.population += c.population;
      if (row.examples.length < 4) row.examples.push(c.city);
      by.set(language, row);
    }
  }
  return [...by.values()].sort((a, b) => b.cities - a.cities || b.population - a.population);
}

const csvField = (v: string | number) =>
  /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const writeCsv = (name: string, header: string[], rows: (string | number)[][]) =>
  writeFileSync(
    join(DIR, name),
    [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n",
  );

const cities = load();
writeCsv(
  "cities-ranked.csv",
  ["rank", "city", "country", "population_2020", "gdp_ppp_per_head_2020", "languages"],
  cities.map((c, i) => [
    i + 1,
    c.city,
    c.country,
    c.population,
    Math.round(c.gdpPerHead),
    c.languages.join(" / "),
  ]),
);

const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const usd = (n: number) => `$${Math.round(n / 1000)}k`;

for (const n of [100, 200]) {
  const rows = rankLanguages(cities.slice(0, n));
  writeCsv(
    `languages-top${n}.csv`,
    ["rank", "language", "cities", "population_2020", "example_cities"],
    rows.map((r, i) => [i + 1, r.language, r.cities, r.population, r.examples.join(" / ")]),
  );
  console.log(`\n## Languages, top ${n} cities (cutoff ${usd(cities[n - 1]!.gdpPerHead)})\n`);
  console.log(
    "| Rank | Language | Cities | People | Examples |\n| --- | --- | ---: | ---: | --- |",
  );
  rows
    .filter((r) => n === 100 || r.cities >= 2)
    .forEach((r, i) =>
      console.log(
        `| ${i + 1} | ${r.language} | ${r.cities} | ${m(r.population)} | ${r.examples.join(", ")} |`,
      ),
    );
}

console.log("\n## Top 40 cities\n");
console.log(
  "| Rank | City | Country | People | GDP per person (PPP) | Languages |\n| ---: | --- | --- | ---: | ---: | --- |",
);
cities
  .slice(0, 40)
  .forEach((c, i) =>
    console.log(
      `| ${i + 1} | ${c.city} | ${c.country} | ${m(c.population)} | ${usd(c.gdpPerHead)} | ${c.languages.join(", ")} |`,
    ),
  );
