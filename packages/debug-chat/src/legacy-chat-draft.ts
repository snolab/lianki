/** Adopt pre-account drafts only after this signed-in page is confirmed as the thread owner. */
import { CHAT_UI_VERSION, migrateChatUi, type ChatUi } from "./ui-store";

export const LEGACY_CHAT_KEY = "lk:ui:chat";
export const LEGACY_CHAT_OWNER_MARKER = "lk:ui:chat-legacy-owner";

export function migrateLegacyOwnerDraft(d: {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  scope: string | null;
  owner: boolean;
}): ChatUi | null {
  if (!d.owner || !d.scope) return null;
  try {
    const marker = d.storage.getItem(LEGACY_CHAT_OWNER_MARKER);
    if (marker) {
      const claim = JSON.parse(marker);
      if (!claim || claim.scope !== d.scope || claim.pending !== true) return null;
    }
    const raw = d.storage.getItem(LEGACY_CHAT_KEY);
    if (!raw) return null;
    const key = `lk:ui:chat:${encodeURIComponent(d.scope)}`;
    const target = migrateChatUi(JSON.parse(d.storage.getItem(key) ?? "{}").state, CHAT_UI_VERSION);
    if (target.legacyOwnerMigrated) {
      // A previous attempt saved the draft but could not finish cleanup.
      d.storage.setItem(
        LEGACY_CHAT_OWNER_MARKER,
        JSON.stringify({ scope: d.scope, pending: false }),
      );
      d.storage.removeItem(LEGACY_CHAT_KEY);
      return null;
    }
    const legacy = migrateChatUi(JSON.parse(raw).state, CHAT_UI_VERSION);
    if (
      (!legacy.draft.trim() && !legacy.interim?.text.trim()) ||
      target.draft.trim() ||
      target.interim?.text.trim()
    )
      return null;
    const restored: ChatUi = {
      ...target,
      draft: legacy.draft,
      pureDictation: legacy.pureDictation,
      caret: legacy.caret,
      interim: legacy.interim,
      attached: legacy.attached,
      legacyOwnerMigrated: true,
    };
    // Bind an interrupted attempt to this verified account before writing its draft.
    d.storage.setItem(LEGACY_CHAT_OWNER_MARKER, JSON.stringify({ scope: d.scope, pending: true }));
    // The receipt and draft land in one durable write, before the old copy is removed.
    const encoded = JSON.stringify({ state: restored, version: CHAT_UI_VERSION });
    d.storage.setItem(key, encoded);
    if (d.storage.getItem(key) !== encoded) return null;
    // Failure here still returns the saved draft; its receipt prevents re-adoption.
    try {
      d.storage.setItem(
        LEGACY_CHAT_OWNER_MARKER,
        JSON.stringify({ scope: d.scope, pending: false }),
      );
      d.storage.removeItem(LEGACY_CHAT_KEY);
    } catch {}
    return restored;
  } catch {
    return null;
  }
}
