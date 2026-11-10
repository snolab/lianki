// What the Google Picker needs from POST /api/connections/google/picker,
// checked before the Picker is built (docs/connections.md, "Importing a
// private doc"). A Picker built with an empty or garbled key shows Google's
// "The API developer key is invalid." page, so anything that is not a
// well-formed setup (an error body, a truncated answer, a cached page) is
// refused here instead of reaching Google. Shared with the server's
// `pickerConfig`, so both sides accept exactly the same values.

export type PickerSetup = { accessToken: string; apiKey: string; appId: string };

/** A Google API key as the console issues it. */
export const PICKER_KEY_RE = /^[A-Za-z0-9_-]{20,100}$/;
/** A Cloud project number (the Picker's app id). */
export const PICKER_APP_ID_RE = /^\d{6,20}$/;

/** The setup in `json`, or null when any field is missing or malformed. */
export function parsePickerSetup(json: unknown): PickerSetup | null {
  if (!json || typeof json !== "object") return null;
  const { accessToken, apiKey, appId } = json as Record<string, unknown>;
  if (typeof accessToken !== "string" || accessToken.trim().length < 10) return null;
  if (typeof apiKey !== "string" || !PICKER_KEY_RE.test(apiKey)) return null;
  const app = typeof appId === "number" ? String(appId) : appId;
  if (typeof app !== "string" || !PICKER_APP_ID_RE.test(app)) return null;
  return { accessToken, apiKey, appId: app };
}

/** The Picker was not shown (bad setup, did not load) or reported an error itself. */
export class PickerError extends Error {
  constructor(readonly code: "bad-setup" | "picker-load" | "picker-error") {
    super(code);
    this.name = "PickerError";
  }
}

/**
 * Fetch a setup and show the Picker; once more when the first try failed in
 * a way a second one can fix (a PickerError: a malformed setup, a Picker that
 * did not load, or one that reported an error). Each try fetches a fresh
 * setup, so the retry never reuses the answer that failed. `fetchSetup`
 * returns the response's JSON as `setup`, or `other` for an outcome the
 * caller handles itself (not connected, rate-limited, …), passed through.
 */
export async function pickWithRetry<T>(
  fetchSetup: () => Promise<{ setup: unknown } | { other: T }>,
  pick: (setup: PickerSetup) => Promise<string[]>,
): Promise<{ ids: string[] } | { other: T }> {
  for (let attempt = 0; ; attempt++) {
    const got = await fetchSetup();
    if ("other" in got) return got;
    const setup = parsePickerSetup(got.setup);
    try {
      if (!setup) throw new PickerError("bad-setup");
      return { ids: await pick(setup) };
    } catch (e) {
      if (attempt > 0 || !(e instanceof PickerError)) throw e;
    }
  }
}
