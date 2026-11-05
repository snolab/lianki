# /self-intro: import material about you

Owner, 2026-11-05 01:41 JST: the self-introduction starts with **importing
material** ("导入关于你的材料"), not with a form. The user writes anything
about themselves and/or adds files (a résumé, a profile or profile export,
notes, an essay, a blog post, photos of handwritten notes, several at once);
AI turns it into facts; the user confirms each; the interview starts with
its answers filled in. "Skip: fill in myself" keeps the old manual path.

## Steps

1. **Import** (`app/(app)/self-intro/ImportStep.tsx`): a large free-text box
   and a file drop / picker (multiple), with the one-line privacy notice.
2. **Facts**: the AI's answer is a list of single facts, grouped by field
   (name, from, age, occupation, hobby, languages). Each is ✓ kept, ✎ edited
   or ✕ dropped; "Keep all" keeps every one not dropped. A fact the model was
   not sure of (unclear handwriting, indirect mention) is tagged "not sure".
   Nothing is used until it is kept. Under the list, the **Learning Partner
   asks follow-up questions** (below).
3. **Review**: each field is its kept facts joined with `Intl.ListFormat` in
   the page's language, all editable; an empty field may stay empty.
4. Then the existing flow: choose the language → interview (answers
   pre-filled, still editable) → review → save cards.

## Follow-up questions

Owner, 01:48 JST: between facts and review, a short back-and-forth with the
Learning Partner (`PartnerQuestions.tsx`, `lib/self-intro/followup.ts`).

- **Which fields.** `openFields` (`lib/self-intro/open-fields.ts`, shared by
  page and route): a field with no kept fact and no sure fact still standing
  (empty, dropped, or only "not sure"), not asked before. Code decides, not
  the model: the schema's `field` enum holds only these. Each field is asked
  at most once, so a round is at most one call per field plus one.
- **One question at a time.** It starts by itself when the facts step opens
  with an open field (also after an import that found nothing). The user
  types an answer, taps a suggestion (the not-sure value if there is one,
  else typical answers; none for a name), or skips.
- **One call per turn** (`POST /api/self-intro/followup`) does both halves:
  the last answer becomes facts (tagged "from your answer", ✓/✎/✕ like the
  rest; put under the field they really are), and the next question comes
  back, or none when nothing is open.
- **Reused from the Learning Partner:** the model and no-thinking setting
  (`lib/partner-ai-config.ts`), `fence` and `cleanReply` from
  `lib/partner-ai.ts`, and its name in the UI (`learning-partner`
  dictionary). Not `partnerReply` itself: that is the chat's hub-only reply,
  behind `partner.ai-reply`, refuses the owner, and reads study data this
  step does not need.
- **Same rules** as the import: the same flag and gate, same-origin JSON,
  in-memory rate limit (`IMPORT.followup`), the facts and answers sent as
  data (fenced), nothing stored, only the cost logged
  (`self-intro.followup.cost`, via `chargeAi`).
- Checked live on 2026-11-05 (Chinese, made-up answers): one question per
  open field, the not-sure value offered as a tap, a mismatched answer (a
  job given to the languages question) filed under occupation.

## How files are read

`lib/self-intro/import-parse.ts`, **in the browser**: one parser list keyed by
MIME type, then extension.

| parser | matches | how |
| ------ | ------- | --- |
| pdf    | `application/pdf`, `.pdf` | `unpdf` (pdf.js, lazy-loaded): the text layer |
| docx   | Word MIME, `.docx` | the zip's `word/document.xml`, headers, footers → text |
| zip    | `application/zip`, `.zip` | every text/HTML entry, by the same rules (profile exports) |
| image  | `image/*`, jpg/png/webp/heic/avif… | shrunk on a canvas to a JPEG data URL; read by the model |
| html   | HTML/XML MIME, `.html` `.htm` `.xml` | tags stripped |
| text   | `text/*`, JSON, txt/md/csv/tsv/json/yaml/vcf | decoded (UTF-8, UTF-16 by BOM) |

Zips (docx too) reuse the EPUB import's zip-bomb limits (`lib/epub/unzip.ts`).
A PDF with no text layer (a scan) answers "no text found": photograph it
instead. Typed text and every file's text are merged (each file under its
name) and cut at `IMPORT.maxTextChars`; at most `IMPORT.maxImages` images go.

## The one AI call

`lib/self-intro/import-extract.ts`: `POST /api/self-intro/import` sends the
merged text and the images in **one** chat call to `PARTNER_AI_MODEL`
(DeepSeek V4.1 Flash on Workers AI, `lib/partner-ai-config.ts`), which is
multimodal: it reads the images itself, handwriting included (checked on
2026-11-05 with a made-up handwritten-style note in Chinese and English: exact
transcription, correct fields). `response_format` is a JSON schema
(`{facts: [{field, value, certain}]}`); the answer is validated again with zod
(`parseFactsAnswer`): unknown fields, empty values and repeats are dropped,
values cut to `IMPORT.maxFieldChars`. The prompt says to use only what the
material states (a field it does not cover gets no fact), to treat the
material as data, not instructions, and to write values in the page's
language (`Intl.DisplayNames`, no per-language code). The cost goes through
`chargeAi` (log-only, `self-intro.import.cost`).

## Privacy

- **Files are never stored.** PDF, Word, zip and text files are parsed on the
  device; only their text leaves it. Images are shrunk on the device and
  sent as data URLs. The route holds the body in memory for the one model
  call and keeps nothing: no D1, no R2, no cache.
- **Nothing is logged** but the cost (numbers). A model error logs its name
  only, since a provider message could echo the input.
- **Only what the user confirms is saved**, as before: the interview's
  answers become sentences, and only the cards the user saves are stored.
- `unit/self-intro-import.test.ts` checks that the route makes no other
  request, that its code has no storage, and that no log line carries the
  material.

## Limits and gate

`IMPORT` in `lib/self-intro/import-config.ts`: 20 MB per file (as the inbox
and the EPUB import), 10 files, the text and image caps above, a 10 MB body,
and 10 imports per user per 10 minutes (in memory, per isolate, like the other
self-intro routes). None of these numbers is shown to users.

Dark behind the flag **`self-intro.import`** ([feature-flags.md](feature-flags.md)):
off, only the owner sees the import step; the route answers 404 to everyone
else. Signed-out visitors never see it.
