/** Live, non-secret presence hint. Never use this marker as an authorization gate. */
export const USERSCRIPT_VERSION_ATTRIBUTE = "data-lianki-userscript-version";
export const USERSCRIPT_INSTALL_URL = "/lianki.user.js";
export const USERSCRIPT_TRY_URL = "https://example.com/";
export type UserscriptInstallState = {
  status: "checking" | "missing" | "outdated" | "ready";
  version: string | null;
};

const versionParts = (value: unknown): number[] | null =>
  typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)
    ? value.split(".").map(Number)
    : null;

export function userscriptInstallState(
  installed: unknown,
  latest: string,
  legacyInstalled = false,
): UserscriptInstallState {
  const parts = versionParts(installed);
  if (!parts)
    return { status: installed != null || legacyInstalled ? "outdated" : "missing", version: null };
  const target = versionParts(latest);
  const order = target
    ? parts.reduce((difference, part, i) => difference || Math.sign(part - target[i]!), 0)
    : -1;
  return { status: order >= 0 ? "ready" : "outdated", version: installed as string };
}

/** A DOM attribute crosses userscript isolated worlds; other websites receive no version marker. */
export function publishUserscriptVersion(
  root: Element,
  origin: string,
  version: unknown,
): () => void {
  if (
    !["https://lianki.com", "https://www.lianki.com", "https://preview.lianki.com"].includes(
      origin,
    ) ||
    !versionParts(version)
  )
    return () => {};
  const value = version as string;
  root.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, value);
  return () => {
    if (root.getAttribute(USERSCRIPT_VERSION_ATTRIBUTE) === value)
      root.removeAttribute(USERSCRIPT_VERSION_ATTRIBUTE);
  };
}

/** Observe live injection and return-to-tab updates. A stale localStorage mirror is not installation proof. */
export function observeUserscriptInstall(
  doc: Document,
  latest: string,
  notify: (state: UserscriptInstallState) => void,
): () => void {
  const win = doc.defaultView;
  const read = () =>
    notify(
      userscriptInstallState(
        doc.documentElement.getAttribute(USERSCRIPT_VERSION_ATTRIBUTE),
        latest,
        (win as (Window & { LIANKI_USERSCRIPT_INSTALLED?: boolean }) | null)
          ?.LIANKI_USERSCRIPT_INSTALLED === true,
      ),
    );
  const observer = new MutationObserver(read);
  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: [USERSCRIPT_VERSION_ATTRIBUTE],
  });
  win?.addEventListener("focus", read);
  doc.addEventListener("visibilitychange", read);
  doc.addEventListener("DOMContentLoaded", read);
  read();
  return () => {
    observer.disconnect();
    win?.removeEventListener("focus", read);
    doc.removeEventListener("visibilitychange", read);
    doc.removeEventListener("DOMContentLoaded", read);
  };
}
