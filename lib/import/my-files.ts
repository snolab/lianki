/**
 * /my/files's folders: each stored file sits in the folder of its origin
 * (the `source` of its row, lib/inbox/store.ts). A source without a folder of
 * its own lands in "other", so a new source never hides a file. No I/O.
 */
import type { InboxSource } from "@/lib/inbox/store";

/** In the order shown (ids are the `my-files` dictionary's `folders` keys). */
export const FOLDERS = ["selfIntro", "import", "chat", "other"] as const;
export type Folder = (typeof FOLDERS)[number];

/** Each source's folder. */
const FOLDER_OF: Record<InboxSource, Folder> = {
  "self-intro": "selfIntro",
  import: "import",
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
