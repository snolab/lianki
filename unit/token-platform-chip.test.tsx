import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mockIntlayer } from "./intlayer-mock";
mockIntlayer("en");
beforeEach(() => mockIntlayer("en"));
const { default: TokenManager } = await import("../app/(app)/my/preferences/TokenManager");
import { stubGlobals } from "./support/globals";

test("platform quick-pick sets only the token name and aria-pressed without POST, scope change, or expiry", async () => {
  const win = new Window({ url: "https://test.invalid/my/preferences" });
  const requests: { url: string; method: string }[] = [];
  const restore = stubGlobals({
    window: win,
    document: win.document,
    location: win.location,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method ?? "GET" });
      return Promise.resolve(Response.json({ account: "u@example.com", tokens: [] }));
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);

  try {
    await act(async () => {
      root.render(<TokenManager />);
    });
    const checkedBefore = [
      ...host.querySelectorAll<HTMLInputElement>('[data-token-picker="permissions"] input'),
    ]
      .filter((el) => el.checked)
      .map((el) => el.dataset.scope);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="token-platform-claude"]')!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      chip.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
    });

    expect(requests.some((r) => r.method === "POST")).toBe(false);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('[data-testid="token-name"]')!.value).toBe(
      "Claude",
    );
    const checkedAfter = [
      ...host.querySelectorAll<HTMLInputElement>('[data-token-picker="permissions"] input'),
    ]
      .filter((el) => el.checked)
      .map((el) => el.dataset.scope);
    expect(checkedAfter).toEqual(checkedBefore);
    const pressedExpiry = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-token-picker="expiry"] button'),
    ].filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressedExpiry).toHaveLength(0);
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
  }
});
