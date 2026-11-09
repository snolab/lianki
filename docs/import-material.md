# Import any material (design stub)

Tree: /import/any

State-tree node `/import/any`. Status: **M1 shipped in its smallest form**
(word lists from .txt/.csv/.tsv, below); the rest is design. Flag
**`import.any`**, default off, no audience: on, every signed-in user gets it
(owner decision 2026-11-10 00:45 JST: free, no credits); off, only the owner
(`isDev`) — `importAnyOn(flags, isDev(email))` —
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
  (below). **Words with AI** on a stored file turns it into a word table on
  the user's credits (below, "AI: a stored file → words").

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
- **Sources.** `import` (this panel), `self-intro` (/self-intro's add-file
  area, docs/self-intro-import.md), `chat` (the chat's attachments). Uploads
  take `?source=import|self-intro`.

### My Files: /my/files (owner, 2026-11-10)

Every file the user stored, in **folders by origin** (`source`):
Self-introduction, Word lists, Chat, Other (`lib/import/my-files.ts`; a new
source lands in Other until it gets a folder). Each row: name, size, time,
**Open** (`GET /api/my/files/<id>`, served to its owner only, as an
attachment) and × (`DELETE /api/my/files/<id>`: the R2 object and the row,
after a 5 s Undo toast; a pending delete is sent at once when the page is
left). Same gate as the store (`import.any`). Linked from the Import panel
("All my files") and from /self-intro. The /my index (and /profile,
/preferences under /my) is another change; this page is `/my/files` only.
Tests: `unit/my-files.test.ts`.
- Tests: `unit/import-files.test.ts`; `scripts/qa/qa-import-wordlist.mjs`
  (upload in the panel → listed → deleted; 404 without the gate).

### AI: a stored file → words (owner, 2026-11-10)

Flag **`words.import-ai`**, default off, no audience: on → every signed-in
user; off → holders of the `dev` permission (`isDev`, a per-account data
grant) — `importAiOn` in `lib/import/ai-convert.ts`, as `importAnyOn`;
either way only with credits covering the smallest hold —
https://lianki.com/dev/flags#words.import-ai. No email in any gate.

A stored file (above) → the **same CSV template** the table import takes →
the table import's own parser, preview and **Add N words**. Not a second
pipeline.

1. Under **Your files**, each file has **Words with AI** — shown only when
   `GET /api/import/ai` says `available` (the gate, Workers AI configured,
   and an admin, no wallet (local dev) or a balance covering the smallest
   hold). The panel asks when it opens.
2. `POST /api/import/ai {fileId, locale}` loads **that user's own** stored
   file (`source = 'import'`, their `owner_id`) from R2 into the request and
   reads it **on the server** with the readers the repo already has
   (`lib/import/ai-read.ts`): the self-intro import's parser list
   (`lib/self-intro/import-parse.ts`: PDF via unpdf, Word/zip with the EPUB
   zip-bomb limits, HTML, text; subtitles `.srt`/`.vtt` as text) and the
   table import's `.xlsx` reader. The stored type is sniffed (a Word file is
   `application/zip`, HTML is `text/plain`), so a known extension picks the
   reader first. A JPEG/PNG/WebP photo goes to the model as an image (≤ ~1.5
   MB); other images and unknown types are "can't be read". Text is cut at
   60,000 characters.
3. The text is cut into chunks of 6,000 characters on line breaks (at most
   10; more → "only the first part"), one call per chunk plus one for the
   image, 3 at a time, to the Learning Partner's DeepSeek on Workers AI
   (`PARTNER_AI_MODEL`). Each call answers JSON rows `{word, meaning,
   example}` (schema, zod-checked; the material is data, not instructions).
   The rows are merged, repeats dropped, capped at 1,500, and written **by
   code** as the template CSV: the header row in the user's UI language
   (`templateFor`), then word, meaning, example.
4. The page (`AiFileImport.tsx`) shows the CSV in an editable box with
   **Download CSV** (UTF-8 BOM) and **Check again**, and under it
   `WordListImport seed`: the table import itself, without its templates and
   inputs, checking that CSV with the same parser and server preview, then
   **Add N words**.

**Credits** (docs/payments.md, feature `words.import-ai`; owner, 2026-11-10):

- **One hold per call** (a chunk, or the image), its fixed most (its prompt,
  image, 4,000 output tokens), taken before that call (`takeHold`), settled
  at its real cost, the rest refunded. The max is never shrunk to fit the
  balance. A balance never goes below zero (the wallet's CHECK).
- **Hard cap.** A call that reports more than its hold is settled at the
  hold and pauses the feature (`credits.overage`); the next call is refused
  (503), nothing charged past any hold.
- A failed call, or a chunk that gave no rows, keeps nothing.
- **Too little to start or to go on** → 402 with `need` (the next call's
  hold: the minimum to start), `recommended` (the balance to finish every
  call left: P95 of this feature's past real per-call costs × the calls
  left, or the hold × the calls left with under 20 samples —
  `lib/payments/recommend.ts`), `have`, and `completed` / `total`. The page
  says "开始至少需要 N 积分，完成整个文件建议 R 积分（当前 H）" and, when some
  parts are done, "已完成 X/Y 部分，充值后继续", with **Get credits** and
  **Continue**.
- **Resume.** Every paid chunk's rows are kept per user and file
  (`ai_chunk_cache`, `0069_ai_chunk_cache.sql`, `lib/import/chunk-cache.ts`,
  keyed by a hash of the call): Continue (or any later run on the same file)
  reuses them for free and pays only for the rest. Dropped when the file is
  deleted. Not a guarantee — hence the recommended balance up front.

**Privacy.** The stored file is read into the request's memory only; its
text goes to Workers AI and nowhere else; nothing new is written but the
wallet's rows and each paid chunk's rows (the resume cache, the user's own,
deleted with the file); logs carry an error name, never content. 20
conversions per user per 10 minutes (per isolate).

Tests: `unit/import-ai.test.ts` (the CSV contract with a mocked model; the
gate; hold / settle / refund / hard cap against a real wallet; the route
reading stored files: own files only, reader by extension, photos, refusals);
`scripts/qa/qa-import-wordlist.mjs` (no button and 402 without credits, 404
with the flag off).

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

### Column mapping (owner, 2026-11-10)

A table (CSV, TSV, a sheet) shows a **mapping step** in the preview
(`app/(app)/import/ColumnMapper.tsx`, `lib/import/column-map.ts`): each file
column is a chip — its header name, or "Column N", and its first value — on
one of the fields **Word / Meaning / Example / Reading / Example translation**
or on **Ignore**. Chips are dragged (dnd-kit: mouse, touch after a short hold
so the page still scrolls, keyboard: Space, arrows, Space, Escape, with
spoken announcements) and reordered; two columns in one field are joined in
their order with "; ". A checkbox says whether the first row is column
names.

- **Defaults**: the header aliases (`HEADER_ALIASES`), else word, meaning,
  example by column order (`tableShape().defaults`). Content-based guessing
  is not built; `MAPPING_GUESSERS` is the hook: a guesser sees the header
  and the first rows and may return a mapping, which wins when it names a
  word column.
- **Live cards**: under the chips, the first rows as /words cards (word and
  reading, then example and meaning in `BACK_ORDER`, on the slip's paper),
  parsed in the page with the mapping at every move. The counts (new /
  already have / skipped) are asked again 400 ms after the chips rest.
- **Sent with the commit**: `mapping` (columns per field) and `header` go with
  both steps; the server checks them (zod, then `cleanMapping`: indices in
  range, each column in one field) and parses with them, so the list holds
  what the cards showed. No word column: Add stays disabled; the server would
  skip every row as "no word".

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
stand-in); no push-socket status; re-importing into an existing list. (The
"Front = column A?" question is the mapping step above.)

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
