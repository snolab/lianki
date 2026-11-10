/**
 * /my/files's folders: each stored file sits in the folder of its origin
 * (the `source` of its row, lib/inbox/store.ts). A source without a folder of
 * its own lands in "other", so a new source never hides a file. No I/O.
 */
import type { InboxSource } from "@/lib/inbox/store";

/** In the order shown (ids are the `my-files` dictionary's `folders` keys). */
export const FOLDERS = ["selfIntro", "import", "books", "chat", "other"] as const;
export type Folder = (typeof FOLDERS)[number];

/** Each source's folder. */
const FOLDER_OF: Record<InboxSource, Folder> = {
  "self-intro": "selfIntro",
  import: "import",
  books: "books",
  chat: "chat",
};

export type MyFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  at: number;
  source: InboxSource | string;
};

/** The folder a file of `source` is listed in. */
export const folderOf = (source: string): Folder =>
  Object.hasOwn(FOLDER_OF, source) ? FOLDER_OF[source as InboxSource] : "other";

/** One row of /my/files's virtual list: a folder's heading (with its count), or a file. */
export type FileRow =
  | { kind: "folder"; key: string; folder: Folder; n: number }
  | { kind: "file"; key: string; file: MyFile };

/** The files as list rows, folder by folder in FOLDERS order, each led by its heading. */
export function fileRows(files: readonly MyFile[]): FileRow[] {
  return FOLDERS.flatMap((folder) => {
    const inFolder = files.filter((f) => folderOf(f.source) === folder);
    if (!inFolder.length) return [];
    return [
      { kind: "folder" as const, key: `folder:${folder}`, folder, n: inFolder.length },
      ...inFolder.map((file) => ({ kind: "file" as const, key: `file:${file.id}`, file })),
    ];
  });
}
