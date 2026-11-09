# Import any material (design stub)

Tree: /import/any

State-tree node `/import/any`. Status: **M1 shipped in its smallest form**
(word lists from .txt/.csv/.tsv, below); the rest is design. Flag
**`import.any`**, default off, `audience: "owner"`: the owner (`isDev`) sees it
with the flag on or off, nobody else either way — never everyone; a later allowlist widens it in `importAnyOn(flags, isDev(email))` —
https://lianki.com/dev/flags#import.any.

## What shipped (M1, 2026-11-09)

/import → **Import a word list**: drop or pick a `.txt` / `.csv` / `.tsv`
file, or paste the list. A preview shows counts — **new**, **already have**,
**skipped** (with the reason per kind) — and the first rows; nothing is saved
until **Add N words**, which makes a new /words list.

| piece                 | where                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| parser (pure)         | `lib/import/wordlist.ts` — `unit/import-wordlist.test.ts`                                       |
| routes                | `POST /api/import/words` (`step: preview \| commit`), `GET /api/import/jobs`                    |
| handler, gate, dedupe | `lib/import/words-handler.ts` — `unit/import-words-handler.test.ts`                             |
| job rows              | `db/migrations/0060_import_jobs.sql` (`import_jobs`)                                            |
| UI                    | `app/(app)/import/WordListImport.tsx`, strings `wordlist-import.content.ts` (`import-wordlist`) |

- **Parsing.** One word per line (list markers `1.` `-` `•` stripped), or
  rows of columns: the delimiter (tab, comma, semicolon) is the one on ≥ 80%
  of the first 20 lines; quoted CSV fields may hold delimiters, `""` and line
  breaks. A first row that names ≥ 2 columns (or names every cell it has) is
  a header; the names are data (`HEADER_ALIASES`: word / meaning / reading /
  example / example translation in many languages). No header: term,
  meaning, example. No branch looks at the list's language.
- **Dedupe.** Within the file by normalized form (`normTerm`: NFC, folded
  spaces, lower case); against the user's words = every term with a card in
  any list, plus every entry of a list kept in D1 (imported decks and lists,
  books' lists). Built-in catalog words never reviewed are not counted (they
  live in static files). Only new words are written.
- **Caps.** 1 MB of text, 20 000 words (`MAX_ENTRIES`), term ≤ 200 chars
  (longer: skipped), meaning/example clipped as the Anki import. 60 requests
  per user per 10 minutes. Not UTF-8 → a plain error asking for UTF-8; a
  binary file → "not a text file".
- **The job.** Inline in the commit request (open question 4: inline now):
  an `import_jobs` row `writing` → the list (`source = "import:<job id>"`,
  an entry list as `anki:`/`book:`, `lib/words/entry-list.ts`) and its
  entries (`WordEntriesD1Repo.sync`, keys from the normalized term) → `done`
  with the counts as JSON in `note`, or `failed` with the half-made list
  deleted. /import lists the latest five jobs with **Open**.
- **Privacy.** The text lives only in the request: no R2 object, no content
  in D1 beyond the words added, logs carry the job id and an error name.

### On /words: the Import button (owner, 2026-11-09)

Same flag. At the top of /words (beside the title) an **Import** button
opens an inline panel: a list of import sources (`SOURCES` in
`app/(app)/words/ImportPanel.tsx`, strings `import-panel.content.ts`,
dictionary `words-import-panel`).

- **Preset word sets** (预制词组) closes the panel and scrolls to the
  existing "Add a list" tree (exam decks, frequency lists, phrases) — the
  same picker, not a copy.
- **CSV or Excel table** opens the word-list import above inside the panel
  (`WordListImport embedded`), loaded on that tap; a list it makes appears in
  the lists at once.
- **Any file** keeps files of any type as the user's own, stored only
  (below). Turning a stored file into words with AI, on the user's credits,
  is the next slice and builds on these stored files.

### Any file: stored, not processed (owner, 2026-11-10)

"Upload any file, store only, don't process yet." Same gate as the panel
(`import.any` through `importAnyOn`: a flag, never an email; #777 opens it
to every signed-in user while it is on).

- **UI.** The panel's third source, **Any file**
  (`app/(app)/words/StoredFiles.tsx`): drop or pick one or more files of
  any type; each uploads as it is, and **Your files** lists them with name,
  size and time, newest first, each with a delete button. Nothing reads,
  parses or converts them.
- **Storage = the chat inbox's** (`lib/inbox/`): R2 `lianki-blobs` under
  `inbox/<user id>/<yyyy>/<mm>/<random id>` (the name is never in the key or
  a log), one `inbox_item` row each, with **`source = 'import'`**
  (`0068_import_files.sql`; the chat's rows are `'chat'`) — open question 1
  below, answered "one table, a source column". The type is sniffed, never
  trusted from the name. Usage (`inbox_usage`) and the caps are shared with
  the inbox: 20 MB a file, 200 MB a rolling day, 2 GB stored, 30 uploads a
  minute (`INBOX`, lib/inbox/config.ts); costs are recorded as the inbox's.
- **Routes** (`lib/import/files.ts`, `app/api/import/files/`): `POST`
  (raw body, `x-file-name`), `GET` (the user's import files and usage),
  `DELETE /<id>` (the R2 object, the row and the usage, for good). Writes
  are same-origin; 401 for a guest, 404 when the gate is off; a user sees
  and deletes only their own files. The chat inbox lists only `'chat'` rows
  and agents' inbox ops only reach those; the import routes only `'import'`.
- **Retention.** Kept until the user deletes it (as the inbox).
- Tests: `unit/import-files.test.ts`; `scripts/qa/qa-import-wordlist.mjs`
  (upload in the panel → listed → deleted; 404 without the gate).

### CSV / Excel

- **.xlsx** is read in the browser (`lib/import/xlsx.ts`): the workbook's
  first sheet (by `workbook.xml` and its relationships), shared strings,
  inline strings, rich-text runs (phonetic `<rPh>` guides left out), cells in
  their own column. It then goes on as CSV text (`rowsToCsv`, padded to ≥ 2
  columns so a one-column header still reads as a header), so the server
  sees one format with the caps above. Limits: 5 MB file, 32 MB per part,
  48 MB decompressed in all, 25 000 rows, 26 columns.
- Reader: **jszip** (already a dependency, MIT, loaded on demand) plus a
  small scanner of the few XML parts — not SheetJS, whose npm release is
  frozen with known advisories. Runs the same in bun tests (no DOMParser).
- **.xls** (the old binary format) is recognised by its OLE signature and
  refused with "save it as .xlsx or CSV UTF-8" — no BIFF reader.

### Templates

"Start from a template" sits at the top of the import with **Excel
template** and **CSV template** buttons (`lib/import/template.ts`, made on
the click, nothing static). The header row is in the user's UI language
(`TEMPLATES`: word / meaning / example per locale, each one an entry of
`HEADER_ALIASES`), then three example rows (English words, the meaning in
that language, an English example). CSV: UTF-8 with a BOM and CRLF, so
Excel opens CJK, Arabic or Devanagari correctly. `.xlsx`: one sheet, header
bold and frozen. `unit/import-template.test.ts` round-trips every locale:
template → parse → the example rows, header detected.

Not in this slice (next): the file is **not** kept as an artifact in R2 and
not counted in usage; no task bar under the nav (the list on /import is the
stand-in); no push-socket status; no "Front = column A?" question (the
preview's header note says how columns were read, and the user cannot remap
them yet); re-importing into an existing list.

## Goal

One place to drop **any** file — a word list, an Anki deck, a book, an
article, a PDF handout, a photo of a vocabulary page — and get the right
thing in Lianki: word books become /words lists, reading becomes /reader
material. The user does not choose a converter; an async job decides the
shape, does the work and reports back.

## User flow

1. **/import → Drop anything** (also the chat's + → File, and the
   userscript later). Pick or drop one or more files.
2. Each file uploads at once (progress chip, as the chat's attachments) and
   becomes the user's file at **/artifacts/<id>/<name>** — listed, kept,
   deletable, counted in their storage.
3. A job starts per file. The **task bar** (a thin strip under the nav, only
   while jobs exist) shows `Reading "list.csv"… → 1,240 words found`.
4. When the job needs a choice it asks one short question in the task bar
   (e.g. "Front = column A, back = column C?" with Yes / Change), never a
   form up front.
5. Done: "Added 1,240 words to _list.csv_" with **Open** (→ /words list or
   /reader document). Failed: one plain sentence why and **Retry** / **Delete
   file**.

## Architecture

Builds on the owner's **chat inbox** (`lib/inbox/`,
[dev-debug-widget.md](dev-debug-widget.md), "Attachments and the inbox"),
which already does most of the storage side for the owner only.

- **Storage.** R2 `lianki-blobs` (no new bucket), key
  `u/<userKey>/artifacts/<id>` ; one D1 row per file (as `inbox` in
  `db/migrations/0035_inbox.sql`: name, sniffed type, size, sha256, created)
  and the per-user **usage row** in the same batch. Same accounting as the
  inbox: bytes stored and uploaded, charged by usage
  (`lib/inbox/charge.ts`, owner decision 2026-11-04 "按用量扣莲"), and the
  safety caps in `INBOX` (file size, bytes per day, stored bytes). Whether
  inbox and artifacts are one table or two: open question 1.
- **Type.** `lib/inbox/sniff.ts` decides from the first bytes; the browser's
  claim and the extension are hints only.
- **Jobs.** A D1 `import_jobs` row per file (`queued → reading → waiting-user
→ writing → done | failed`, `kind`, `result_ref`, a short `note`). The
  worker side runs on a **Cloudflare Queue** consumer (or a Workflow when a
  job needs to wait for the user's answer) bound to the `lianki` Worker;
  status reaches the page over the existing push socket (lianki-push), so
  the task bar is event-driven, no polling.
- **Converters**, one per kind, pure where possible and unit-tested:

  | kind                   | how                                                      | target                                                    |
  | ---------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
  | txt / csv / tsv        | delimiter + header sniff; columns → term/back/reading/ex | /words list (`WordEntriesD1Repo`, as `/api/words/import`) |
  | Anki `.apkg`/`.colpkg` | the existing import (`/words/import`, `lib/words/anki`)  | /words list                                               |
  | EPUB                   | the existing EPUB import (`lib/epub/`)                   | /reader book                                              |
  | PDF                    | text layer (`unpdf`, as self-intro); scans → image path  | /reader, or /words if it is a list                        |
  | DOCX / HTML            | text extraction as `lib/self-intro/import-parse.ts`      | /reader or /words                                         |
  | images                 | the multimodal model reads the page (as self-intro)      | /words (vocab page) or /reader                            |

- **The agent step.** Only where rules cannot decide: one model call
  ([workers-ai.md](workers-ai.md), `PARTNER_AI_MODEL`) sees a **sample** (first
  ~50 lines / the first page) and answers a JSON schema: `{shape: "wordlist" |
"reading" | "deck" | "unknown", columns?, lang?, question?}`. The material
  is data, not instructions (the prompt says so; the answer is validated with
  zod). Cost through `chargeAi`.

## Security and privacy

- **Uploads are untrusted.** Type from sniffing, never from the name; HTML,
  SVG and XML are stored as `text/plain` and only ever downloaded as an
  attachment (as the inbox). Nothing a user uploaded renders as a page.
- **Sandboxed parsing.** Text formats parse in the browser first where
  possible (as self-intro). Server-side parsing runs in the queue consumer
  with only the bindings it needs (read that one R2 object, write that one
  job row and its result); no network fetches from the material (links in a
  document are text, never followed); zip/EPUB/DOCX through the zip-bomb
  limits of `lib/epub/unzip.ts`; a CPU/time cap per job; PDF via pdf.js with
  scripting off. Parsers never `eval`.
- **Limits.** Per file and per day as `INBOX` (owner may change); a job's
  extracted text capped; at most N jobs running per user (queue concurrency).
- **Private.** Files and results belong to the uploader only; no shared
  cache, no public link. A file is fetched through the user's own session or
  a single-use ticket. Logs carry ids, sizes and costs, never content.
- **Deleting** a file removes the R2 object and the row (usage updated in
  the same batch); cards and /reader material already made from it stay.

## Milestones

| #   | slice                                                                                                                                                                                                                                                                                                                         | ETA  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1  | **Shipped smaller** (above): txt/csv → preview → /words list, job rows, no R2 artifact yet. Planned: **First slice**: /import → drop a **txt or csv word list** → upload to R2 as the user's artifact (usage counted) → job (rules only, no model) → a /words list; status in a minimal task bar; flag dark, on for the owner | 4H   |
| M2  | /artifacts list page: name, size, usage line, delete                                                                                                                                                                                                                                                                          | 1.5H |
| M3  | Anki and EPUB through the same pipeline (reuse existing importers)                                                                                                                                                                                                                                                            | 2.5H |
| M4  | PDF / DOCX / HTML text → /reader; the agent step for "list or reading?" with one question in the task bar                                                                                                                                                                                                                     | 4H   |
| M5  | Images (vocab page photos) → /words via the multimodal model                                                                                                                                                                                                                                                                  | 2.5H |
| M6  | Queue consumer hardening: per-job CPU cap, retries, dead-letter, qa script with hostile files                                                                                                                                                                                                                                 | 3H   |

ETAs include the local gate and ~10M pipeline.

## Open questions

1. One table with the chat inbox (an inbox file is an artifact) or two? The
   default proposal: one table, a `source` column (`chat` | `import`).
2. The storage "limit": the inbox has no product quota, only usage charging
   and safety caps. Keep that for everyone, or a free-tier cap?
3. Where does the task bar live on phones: under the nav, or in the bottom
   nav as a badge?
4. M1 job runner: run the txt/csv job inline (small files) and add the Queue
   in M4, or set up the Queue binding from day one?
