# Sources for the internet-jobs wage tables

Every CSV keeps values exactly as the agency published them (empty = not
published). `scripts/blog-data/internet-wages.ts` turns them into gross annual
PPP dollars. Collected 2026-10-21.

| File | Agency and release | Tables | Geography | Measure |
| --- | --- | --- | --- | --- |
| us.csv | BLS OEWS, May 2025 | oesm25ma.zip (MSA_M2025_dl.xlsx), oesm25nat.zip | 23 metropolitan statistical areas + national | Annual wage, wage and salary employees; P10–P90 |
| ca.csv | Statistics Canada, 2021 Census (income year 2020) | 98-10-0452-01 (medians), 98-10-0596-01 (brackets), 98-10-0598-01 (industries) | 10 CMAs, place of residence | Employment income, full-year full-time workers 15+, incl. self-employed. P10–P90 for all workers are interpolated from brackets that include benefits — not used in the post |
| uk.csv | ONS ASHE 2025 provisional; NISRA for Northern Ireland | Table 7 (place of work by local authority), 15 (region × SOC 2020), 5 (region × SIC) | Cities (all occupations); regions (occupations, industries) | Gross annual pay, full-time employee jobs, same job > 1 year |
| de.csv | Bundesagentur für Arbeit, Entgeltstatistik 31.12.2025 | entgelt-dwolk-0-202512.xlsx, sheets 8.1 and 8.4 | kreisfreie Städte, place of work | Median monthly gross, full-time, Kerngruppe; capped at the pension contribution ceiling (€8,050/month in 2025) |
| jp.csv | MHLW 賃金構造基本統計調査 令和7年 (June 2025) | 都道府県別第1表, 第3表; 産業大分類第3表; 職種第17表 (e-Stat) | Prefectures (means only); national (P10–P90) | Monthly scheduled earnings (所定内給与額), regular full-time, private, 10+ employees |
| fr.csv | INSEE, Base Tous salariés 2024; Insee Première 2079; DERA 2024 | DS_BTS_SAL_EQTP_SEX_PCS, ip2079.xlsx, DS_DERA_PRIVE_ANNUEL | Aires d'attraction des villes (means only); national (deciles) | Net monthly salary, FTE, private sector — not used in the gross tables |
| au.csv | ABS Employee Earnings, Aug 2025; Personal Income in Australia 2022-23 | 6337.0 Tables 2, 3, 4b; Table 5.1 | Capital cities (medians); states and national (P10–P90) | Weekly earnings in main job, gross |
| es.csv | INE Encuesta Anual de Estructura Salarial 2024; Cuatrienal 2022 | 28191, 36848, 36829, 36830 | Comunidades autónomas; national | Gross annual earnings per worker |
| fr_zone.csv | BFS/OFS Swiss Earnings Structure Survey 2024; STATEC ESS 2022; Statbel SES 2022 (via IWEPS) and Eurostat earn_ses22 | BFS cubes px-x-0304010000_201/_205, table je-d-03.04.02.00.01; STATEC DSD_ESS_2@DF_C1330; IWEPS L030-SALAIRE | Swiss Grossregionen + national; Luxembourg national; Belgian regions + national | Swiss: gross monthly standardised to full time incl. 1/12 of 13th month; Luxembourg: gross annual per FTE; Belgium: October gross monthly, full-time private sector (excl. 13th month and holiday pay) |
| so_survey*.csv | Stack Overflow Developer Survey 2025 (ODbL) | results.csv from StackExchange/Survey | Countries with 100+ answers | ConvertedCompYearly (USD at exchange rates), MainBranch = developer by profession, Employment = Employed, $1k–$1M |

PPP factors: World Bank PA.NUS.PRVT.PP (private consumption), data updated
2026-10-08, for each source's own year.
