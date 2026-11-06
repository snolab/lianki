// A checked Google Doc into the user's /read, shared by the import
// (app/api/read/gdoc) and the live stream (app/api/read/gdoc/stream): the same
// doc is the same book (`source_key` gdoc:<id>), updated in place, the FSRS
// state of every unchanged line carried over to the new text's sentence ids.
import {
  findReadMaterialBySource,
  getReadMaterialContent,
  replaceReadMaterialText,
  saveReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { gdocSourceKey, gdocUrlOf } from "@/lib/gdoc/url";
import { bookMetaOf, parseBookMeta, type ParsedBook } from "./book";
import { prepareBook } from "./prep-server";
import { hashOf, readerBook } from "./reader-book";
import {
  carrySentenceCards,
  carrySentenceCardsByText,
  dropRawText,
  unchangedLines,
  type D1Batch,
} from "./reader-store";
import { sentenceCarryMap } from "./sentence-cards";
import { bookHash } from "./units";

export interface StoredGdoc {
  id: string;
  title: string;
  lineCount: number;
  updated: boolean;
  changed: boolean;
  /** The book's content hash after this store. */
  hash: string;
}

export async function storeGdocBook(
  db: D1Batch,
  userId: string,
  docId: string,
  checked: ParsedBook,
): Promise<StoredGdoc> {
  // The import pipeline (docs/books-plan.md): detect, then bite size at his
  // own pace, each line in its own language. A Docs line break is a paragraph.
  const { book: b, shape } = await prepareBook(checked, {
    db,
    userId,
    splitBreaks: true,
  });
  const meta = bookMetaOf(b, { source: "gdoc", sourceUrl: gdocUrlOf(docId), shape });
  const content = JSON.stringify(meta);
  const hash = await bookHash(b.lines);
  const key = gdocSourceKey(docId);

  const prev = await findReadMaterialBySource(userId, key);
  if (prev) {
    const pid = String(prev._id);
    const prevHash = await hashOf(prev);
    if (prevHash !== hash) {
      const same = unchangedLines(prev.lines, b.lines);
      await carrySentenceCards(db, userId, prevHash, hash, same);
      // Lines cut anew (bite size, a polish undone): the rest by sentence text.
      const prevMeta = parseBookMeta(await getReadMaterialContent(prev));
      const kept = new Set(same.map(([o]) => o));
      if (kept.size < prev.lines.length) {
        const oldB = readerBook(prev.lines, prevMeta, prevHash);
        const newB = readerBook(b.lines, meta, hash);
        await carrySentenceCardsByText(
          db,
          userId,
          prevHash,
          hash,
          sentenceCarryMap(oldB.sentences, oldB.lines, newB.sentences, newB.lines),
        );
      }
    }
    // The doc's text is the raw text now: a polish of the old one goes with it.
    await dropRawText(db, userId, pid);
    await replaceReadMaterialText(userId, pid, b.title, b.lines, content, hash);
    return {
      id: pid,
      title: b.title,
      lineCount: b.lines.length,
      updated: true,
      changed: prevHash !== hash,
      hash,
    };
  }

  const material = await saveReadMaterial(userId, b.title, content, b.lines, hash, key);
  return {
    id: String(material._id),
    title: material.title,
    lineCount: material.lines.length,
    updated: false,
    changed: true,
    hash,
  };
}
