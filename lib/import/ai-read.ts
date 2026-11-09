/**
 * "AI: a stored file → words": a stored import file → the text (and images)
 * the conversion takes, read on the server with the repo's existing readers:
 * the self-intro import's parser list (PDF via unpdf, Word, zip, HTML, text,
 * images — lib/self-intro/import-parse.ts) and the table import's .xlsx
 * reader (lib/import/xlsx.ts). The text is cut to `AI_IMPORT.maxTextChars`.
 *
 * The stored type is sniffed (lib/inbox/sniff.ts): a Word file is
 * "application/zip", HTML is "text/plain". So a known extension picks the
 * reader first; the type decides only for images and unknown names.
 */
import {
  ImportFileError,
  parseImportFile,
  pickParser,
  type FileLike,
  type ParseDeps,
} from "@/lib/self-intro/import-parse";
import { AI_IMPORT } from "./ai-config";
import { readXlsx, rowsToCsv } from "./xlsx";

export type AiPayload = { text: string; images: string[]; truncated: boolean };

/** Subtitles, lyrics and tables: text, whatever type was stored. */
const TEXT_LIKE = /\.(srt|vtt|lrc|ass|ssa|sub|tsv|csv|txt|md)$/i;

/** The type a file is read as: its extension's reader when known, else its stored type. */
function readAs(file: FileLike): string {
  if (TEXT_LIKE.test(file.name)) return "text/plain";
  const byExt = pickParser(file.name, "");
  return byExt && byExt.id !== "image" ? "" : file.type;
}

/** One file → the payload. Throws `ImportFileError` (too-large, unsupported, unreadable, empty). */
export async function readAnyFile(file: FileLike, deps: ParseDeps = {}): Promise<AiPayload> {
  if (file.size > AI_IMPORT.maxFileBytes) throw new ImportFileError("too-large", file.name);
  let text = "";
  const images: string[] = [];
  if (/\.xlsx$/i.test(file.name)) {
    try {
      text = rowsToCsv(await readXlsx(await file.arrayBuffer()));
    } catch {
      throw new ImportFileError("unreadable", file.name);
    }
  } else {
    const like: FileLike = {
      name: file.name,
      type: readAs(file),
      size: file.size,
      arrayBuffer: () => file.arrayBuffer(),
    };
    for (const p of await parseImportFile(like, deps))
      if (p.kind === "text") text += (text ? "\n\n" : "") + p.text;
      else images.push(p.dataUrl);
  }
  if (!text.trim() && !images.length) throw new ImportFileError("empty", file.name);
  const truncated = text.length > AI_IMPORT.maxTextChars || images.length > AI_IMPORT.maxImages;
  return {
    text: text.slice(0, AI_IMPORT.maxTextChars),
    images: images.slice(0, AI_IMPORT.maxImages),
    truncated,
  };
}
