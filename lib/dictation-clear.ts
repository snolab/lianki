/** Cancellation only, on the private PUSH service binding. Never a public capability. */
export const DICTATION_CLEAR_PATH = "/internal/dictation-clear";
export type DictationPush = { fetch(request: Request): Promise<Response> };

export async function clearDictation(
  push: DictationPush | null,
  account?: string,
): Promise<boolean> {
  if (!push) return false;
  try {
    const response = await push.fetch(
      new Request(`https://lianki-push${DICTATION_CLEAR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(account === undefined ? {} : { account }),
        signal: AbortSignal.timeout(5000),
      }),
    );
    return response.ok && ((await response.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export async function readDictationClear(req: Request): Promise<{ account?: string } | null> {
  if (req.method !== "POST" || new URL(req.url).hostname !== "lianki-push" || !req.body)
    return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== "account")) return null;
    if (
      Object.hasOwn(value, "account") &&
      (typeof value.account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.account))
    )
      return null;
    return value.account === undefined ? {} : { account: value.account as string };
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
