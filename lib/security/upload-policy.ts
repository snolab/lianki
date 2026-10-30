/**
 * What a user may upload (docs/security-measures.md, 脆弱性対策 ②). Uploads are
 * parsed in memory and never stored or served, but the endpoints still refuse
 * anything that is not the one format they read:
 *
 * - `/api/import/anki`: `.apkg` (a zip — checked by its magic bytes too), ≤ 100 MB;
 * - `/api/import/yaml`: `.yaml` / `.yml` exports, ≤ 10 MB.
 */
export interface UploadRule {
  extensions: readonly string[];
  maxBytes: number;
  /** Leading bytes the file must start with, if the format has them. */
  magic?: readonly number[];
}

const MB = 1024 * 1024;

export const APKG_UPLOAD: UploadRule = {
  extensions: [".apkg"],
  maxBytes: 100 * MB,
  magic: [0x50, 0x4b, 0x03, 0x04], // "PK\x03\x04", a zip
};

export const YAML_UPLOAD: UploadRule = { extensions: [".yaml", ".yml"], maxBytes: 10 * MB };

export type UploadVerdict = { ok: true } | { ok: false; error: string };

/** Name and size, before the body is read. */
export function checkUpload(file: { name: string; size: number }, rule: UploadRule): UploadVerdict {
  const name = file.name.toLowerCase();
  if (!rule.extensions.some((ext) => name.endsWith(ext)))
    return { ok: false, error: `File must be ${rule.extensions.join(" or ")}` };
  if (file.size > rule.maxBytes)
    return { ok: false, error: `File too large (max ${Math.round(rule.maxBytes / MB)} MB)` };
  if (file.size === 0) return { ok: false, error: "File is empty" };
  return { ok: true };
}

/** The first bytes, once read. */
export function checkMagic(bytes: ArrayBuffer | Uint8Array, rule: UploadRule): UploadVerdict {
  if (!rule.magic) return { ok: true };
  const head = new Uint8Array(
    bytes instanceof Uint8Array ? bytes.buffer : bytes,
    0,
    rule.magic.length,
  );
  const match = rule.magic.every((b, i) => head[i] === b);
  return match ? { ok: true } : { ok: false, error: "File is not a valid archive" };
}
