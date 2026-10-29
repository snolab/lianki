"use client";
import { useEffect, useState, useTransition } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { authClient } from "@/lib/auth-client";
import { defaultPasskeyName, passkeyErrorKind } from "@/lib/passkey";

type Passkey = { id: string; name?: string | null; createdAt?: string | Date | null };

/**
 * The signed-in user's passkeys: list (name, date added), add, rename, delete.
 *
 * The list is read once on mount and re-read only after this card changes it —
 * no polling.
 */
export default function PasskeysCard() {
  const t = useIntlayer("profile-page");
  const { locale } = useLocale();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function reload() {
    const { data, error } = await authClient.passkey.listUserPasskeys();
    if (error) setError(t.actionFailed.value);
    else setPasskeys((data ?? []) as Passkey[]);
  }

  useEffect(() => {
    setSupported(typeof PublicKeyCredential !== "undefined");
    void reload();
    // reload() only reads stable module state; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function add() {
    setError("");
    startTransition(async () => {
      const result = await authClient.passkey.addPasskey({
        name: defaultPasskeyName(navigator.userAgent),
      });
      if (result?.data && !result.error) return reload();
      const kind = passkeyErrorKind(result?.error);
      if (kind === "duplicate") setError(t.alreadyRegistered.value);
      else if (kind === "stale-session") setError(t.signInAgain.value);
      else if (kind !== "cancelled") setError(t.addFailed.value);
    });
  }

  function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const { id, name } = editing;
    setError("");
    startTransition(async () => {
      const { error } = await authClient.passkey.updatePasskey({ id, name: name.trim() });
      if (error) return setError(t.actionFailed.value);
      setEditing(null);
      await reload();
    });
  }

  function remove(id: string) {
    setError("");
    startTransition(async () => {
      const { error } = await authClient.passkey.deletePasskey({ id });
      if (error) return setError(t.actionFailed.value);
      setConfirming(null);
      await reload();
    });
  }

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <section
      aria-labelledby="passkeys-heading"
      className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6"
    >
      <h2 id="passkeys-heading" className="text-2xl font-semibold mb-2">
        {t.passkeys}
      </h2>
      <p className="text-sm text-gray-500 mb-4">{t.passkeysIntro}</p>

      {passkeys && passkeys.length === 0 && (
        <p className="text-sm text-gray-500 mb-4">{t.noPasskeys}</p>
      )}
      {passkeys && passkeys.length > 0 && (
        <ul
          className="divide-y divide-gray-200 dark:divide-gray-700 mb-4"
          data-testid="passkey-list"
        >
          {passkeys.map((pk) => (
            <li key={pk.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {editing?.id === pk.id ? (
                <form onSubmit={rename} className="flex flex-wrap items-center gap-2 grow">
                  <label htmlFor={`passkey-name-${pk.id}`} className="sr-only">
                    {t.passkeyName}
                  </label>
                  <input
                    id={`passkey-name-${pk.id}`}
                    value={editing.name}
                    onChange={(e) => setEditing({ id: pk.id, name: e.target.value })}
                    maxLength={64}
                    required
                    autoFocus
                    className="border border-gray-300 dark:border-gray-600 px-2 py-1 rounded dark:bg-gray-900 grow min-w-0"
                  />
                  <button
                    type="submit"
                    disabled={isPending || !editing.name.trim()}
                    className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                  >
                    {t.save}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-sm text-gray-500 hover:underline"
                  >
                    {t.cancel}
                  </button>
                </form>
              ) : (
                <>
                  <div className="grow min-w-0">
                    <p className="font-medium truncate">{pk.name || t.passkeyUnnamed}</p>
                    {pk.createdAt && (
                      <p className="text-xs text-gray-500">
                        {t.addedOn} {dateFmt.format(new Date(pk.createdAt))}
                      </p>
                    )}
                  </div>
                  {confirming === pk.id ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span>{t.confirmDelete}</span>
                      <button
                        type="button"
                        onClick={() => remove(pk.id)}
                        disabled={isPending}
                        className="text-red-600 hover:underline disabled:opacity-50"
                      >
                        {t.deletePasskey}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="text-gray-500 hover:underline"
                      >
                        {t.cancel}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-3 text-sm">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(null);
                          setEditing({ id: pk.id, name: pk.name ?? "" });
                        }}
                        className="text-blue-600 hover:underline"
                      >
                        {t.rename}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setConfirming(pk.id);
                        }}
                        className="text-red-600 hover:underline"
                      >
                        {t.deletePasskey}
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-red-500 text-sm mb-3">
          {error}
        </p>
      )}
      {supported ? (
        <button
          type="button"
          onClick={add}
          disabled={isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
        >
          {isPending ? t.addingPasskey : t.addPasskey}
        </button>
      ) : (
        <p className="text-sm text-gray-500">{t.notSupported}</p>
      )}
    </section>
  );
}
