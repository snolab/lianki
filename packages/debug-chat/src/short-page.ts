/**
 * A connected page as a user without `dev` sees it in the chat menu
 * (DebugChat): the path's first segment ("/words/abc?x=1" → "/words"), never
 * ids, queries or devices (owner, 2026-11-11 01:31 JST).
 */
export function shortPage(path: string): string {
  const first = path.split(/[?#]/)[0].split("/").filter(Boolean)[0];
  return first ? `/${first}` : "/";
}
