"use client";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { isOwnAvatar } from "@/lib/profile/avatar";
import { PROFILE } from "@/lib/profile/config";
import { downscaleAvatar } from "./avatar-downscale";

/** A 44px icon button: the touch target stays whole on any pointer. */
const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50";
const ROW = "flex items-center gap-2 min-h-11 mb-2";
const ERROR = "text-sm text-red-600 dark:text-red-400 mb-2";

/**
 * The User Information card's fields, each with a pen. After a save the server's
 * layout is re-rendered (router.refresh), so the nav's name and avatar change at
 * once. The address changes only after its mailed link is confirmed
 * (lib/profile/email-change.ts), so here it only asks.
 */
export function ProfileFields(props: {
  name: string;
  email: string;
  image: string | null;
  /** The routes behind the pens exist only on the D1 backend. */
  editable: boolean;
  /** D1, and a mail provider to send the link. */
  emailEditable: boolean;
}) {
  const page = useIntlayer("profile-page");
  const t = useIntlayer("profile-edit");
  const router = useRouter();

  const [name, setName] = useState(props.name);
  const [draft, setDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  const penRef = useRef<HTMLButtonElement>(null);

  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<{ ok: boolean; text: ReactNode } | null>(null);

  const [image, setImage] = useState(props.image);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<ReactNode>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Close the editor and hand the keyboard back to the pen, which is rendered again by then. */
  function closeEditor() {
    setDraft(null);
    setNameError(null);
    requestAnimationFrame(() => penRef.current?.focus());
  }

  async function askEmail(e: React.FormEvent) {
    e.preventDefault();
    if (emailDraft === null || emailBusy) return;
    setEmailBusy(true);
    setEmailNote(null);
    try {
      const r = await fetch("/api/profile/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailDraft }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) {
        setEmailDraft(null);
        setEmailNote({ ok: true, text: t.emailSent });
        return;
      }
      const reasons: Record<string, ReactNode> = {
        invalid: t.emailInvalid,
        same: t.emailSame,
        owner: t.emailOwner,
        "sign-in-again": t.emailSignInAgain,
        "rate-limited": t.tooMany,
      };
      setEmailNote({ ok: false, text: reasons[body.error ?? ""] ?? t.saveFailed });
    } catch {
      setEmailNote({ ok: false, text: t.saveFailed });
    } finally {
      setEmailBusy(false);
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (draft === null || saving) return;
    setSaving(true);
    setNameError(null);
    try {
      const r = await fetch("/api/profile/name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft }),
      });
      const body = (await r.json().catch(() => ({}))) as { name?: string; error?: string };
      if (r.ok && body.name) {
        setName(body.name);
        closeEditor();
        router.refresh();
      } else if (body.error === "empty") setNameError(t.nameEmpty);
      else if (body.error === "too-long") setNameError(t.nameTooLong);
      else if (r.status === 429) setNameError(t.tooMany);
      else setNameError(t.saveFailed);
    } catch {
      setNameError(t.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  function nameKeys(e: KeyboardEvent<HTMLInputElement>) {
    // Enter or Esc while an IME is composing belongs to the IME.
    if (e.nativeEvent.isComposing) {
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "Escape") closeEditor();
  }

  /** What a refused avatar request says. */
  function avatarRefusal(status: number, error?: string) {
    if (error === "bad-type") return t.avatarBadType;
    if (error === "too-big") return t.avatarTooBig;
    return status === 429 ? t.tooMany : t.saveFailed;
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const shrunk = await downscaleAvatar(file);
      if (typeof shrunk === "string") return setAvatarError(avatarRefusal(0, shrunk));
      const r = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: { "content-type": shrunk.type },
        body: shrunk,
      });
      const body = (await r.json().catch(() => ({}))) as { image?: string; error?: string };
      if (!r.ok || !body.image) return setAvatarError(avatarRefusal(r.status, body.error));
      setImage(body.image);
      router.refresh();
    } catch {
      setAvatarError(t.saveFailed);
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = ""; // the same file can be picked again
    }
  }

  async function removeUpload() {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const r = await fetch("/api/profile/avatar", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      const body = (await r.json().catch(() => ({}))) as { image?: string | null; error?: string };
      if (!r.ok) return setAvatarError(avatarRefusal(r.status, body.error));
      setImage(body.image ?? null);
      router.refresh();
    } catch {
      setAvatarError(t.saveFailed);
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <>
      {draft === null ? (
        <div className={ROW}>
          <p className="min-w-0 break-words">
            <strong>{page.name}</strong> {name || page.notAvailable}
          </p>
          {props.editable && (
            <button
              ref={penRef}
              type="button"
              className={ICON_BUTTON}
              aria-label={t.editName.value}
              title={t.editName.value}
              onClick={() => setDraft(name)}
              data-testid="edit-name"
            >
              <Icon name="pencilSimple" />
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={saveName} className={ROW}>
          <label htmlFor="profile-name">
            <strong>{page.name}</strong>
          </label>
          <input
            id="profile-name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={nameKeys}
            maxLength={PROFILE.nameMaxChars}
            autoComplete="name"
            autoFocus
            onFocus={(e) => e.target.select()}
            aria-label={t.nameField.value}
            aria-invalid={nameError ? true : undefined}
            className="min-w-0 grow rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900"
          />
          <button
            type="submit"
            disabled={saving}
            className={ICON_BUTTON}
            aria-label={t.saveName.value}
            title={t.saveName.value}
            data-testid="save-name"
          >
            <Icon name="check" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t.cancelEdit.value}
            title={t.cancelEdit.value}
            onClick={closeEditor}
            data-testid="cancel-name"
          >
            <Icon name="x" />
          </button>
        </form>
      )}
      {nameError && (
        <p role="alert" className={ERROR}>
          {nameError}
        </p>
      )}

      {emailDraft === null ? (
        <div className={ROW}>
          <p className="min-w-0 [overflow-wrap:anywhere]">
            <strong>{page.email}</strong> {props.email}
          </p>
          {props.emailEditable && (
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t.editEmail.value}
              title={t.editEmail.value}
              onClick={() => {
                setEmailNote(null);
                setEmailDraft("");
              }}
              data-testid="edit-email"
            >
              <Icon name="pencilSimple" />
            </button>
          )}
        </div>
      ) : (
        <>
          <form onSubmit={askEmail} className={ROW}>
            <label htmlFor="profile-email">
              <strong>{page.email}</strong>
            </label>
            <input
              id="profile-email"
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEmailDraft(null);
              }}
              placeholder={t.emailField.value}
              aria-label={t.emailField.value}
              autoComplete="email"
              autoFocus
              required
              maxLength={254}
              className="min-w-0 grow rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900"
            />
            <button
              type="submit"
              disabled={emailBusy}
              className={ICON_BUTTON}
              aria-label={t.emailSend.value}
              title={t.emailSend.value}
              data-testid="save-email"
            >
              <Icon name="check" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t.cancelEdit.value}
              title={t.cancelEdit.value}
              onClick={() => setEmailDraft(null)}
            >
              <Icon name="x" />
            </button>
          </form>
          <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{t.emailHow}</p>
          <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{t.emailGoogle}</p>
        </>
      )}
      {emailNote &&
        (emailNote.ok ? (
          <p role="status" className="mb-2 text-sm text-gray-500 dark:text-gray-400">
            {emailNote.text}
          </p>
        ) : (
          <p role="alert" className={ERROR}>
            {emailNote.text}
          </p>
        ))}

      {(image || props.editable) && (
        <>
          <p className="mt-2">
            <strong>{page.avatar}</strong>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {image ? (
              // Plain <img>: any provider's host, and our own route.
              <img
                src={image}
                alt={page.userAvatarAlt.value}
                className="size-32 rounded-full object-cover"
                data-testid="profile-avatar"
              />
            ) : (
              <span className="inline-flex size-32 items-center justify-center rounded-full bg-gray-100 text-5xl text-gray-400 dark:bg-gray-700">
                <Icon name="user" />
              </span>
            )}
            {props.editable && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  // SVG is left out on purpose: it can carry script.
                  accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => void pick(e.target.files?.[0])}
                  data-testid="avatar-file"
                />
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={t.editAvatar.value}
                  title={t.editAvatar.value}
                  disabled={avatarBusy}
                  onClick={() => fileRef.current?.click()}
                  data-testid="edit-avatar"
                >
                  <Icon name="pencilSimple" />
                </button>
                {isOwnAvatar(image) && (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50"
                    disabled={avatarBusy}
                    onClick={() => void removeUpload()}
                    data-testid="remove-avatar"
                  >
                    <Icon name="trash" />
                    {t.removeAvatar}
                  </button>
                )}
              </>
            )}
          </div>
          {avatarBusy && (
            <p role="status" className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {t.uploading}
            </p>
          )}
          {avatarError && (
            <p role="alert" className={`${ERROR} mt-2`}>
              {avatarError}
            </p>
          )}
        </>
      )}
    </>
  );
}
