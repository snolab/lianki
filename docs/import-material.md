# Import any material (design stub)

State-tree node `/import/any`. Status: design only, nothing built. Flag
**`import.any`**, default off, on for the owner when it ships.

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
  | EPUB                   | the existing EPUB import (`lib/epub/`)                   | /reader book                                                |
  | PDF                    | text layer (`unpdf`, as self-intro); scans → image path  | /reader, or /words if it is a list                          |
  | DOCX / HTML            | text extraction as `lib/self-intro/import-parse.ts`      | /reader or /words                                           |
  | images                 | the multimodal model reads the page (as self-intro)      | /words (vocab page) or /reader                              |

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

| #   | slice                                                                                                                                                                                                                    | ETA  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| M1  | **First slice**: /import → drop a **txt or csv word list** → upload to R2 as the user's artifact (usage counted) → job (rules only, no model) → a /words list; status in a minimal task bar; flag dark, on for the owner | 4H   |
| M2  | /artifacts list page: name, size, usage line, delete                                                                                                                                                                     | 1.5H |
| M3  | Anki and EPUB through the same pipeline (reuse existing importers)                                                                                                                                                       | 2.5H |
| M4  | PDF / DOCX / HTML text → /reader; the agent step for "list or reading?" with one question in the task bar                                                                                                                  | 4H   |
| M5  | Images (vocab page photos) → /words via the multimodal model                                                                                                                                                             | 2.5H |
| M6  | Queue consumer hardening: per-job CPU cap, retries, dead-letter, qa script with hostile files                                                                                                                            | 3H   |

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
