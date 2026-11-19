/** Device bookkeeping only. A missing new-account row must never expose an old account's terms. */
import { SYNC_KEY } from "@lianki/ui-state/account";
export function glossaryAccount(): string | null {
  try {
    const id: unknown = JSON.parse(localStorage.getItem(SYNC_KEY) ?? "null")?.userId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
export function readGlossaryPref(key: string, userId = glossaryAccount()): unknown {
  try {
    if (!userId) return undefined;
    const envelope = JSON.parse(localStorage.getItem(key) ?? "null");
    return envelope?.userId === userId ? envelope.value : undefined;
  } catch {
    return undefined;
  }
}
export function writeGlossaryPref(key: string, value: unknown, userId = glossaryAccount()): void {
  if (!userId) return;
  localStorage.setItem(key, JSON.stringify({ userId, value }));
}
