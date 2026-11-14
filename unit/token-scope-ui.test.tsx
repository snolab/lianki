import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { TokenScopeApproval } from "../app/(app)/my/tokens/scopes/TokenScopeClient";
import { stubGlobals } from "./support/globals";
import { DEFAULT_TOKEN_SCOPES } from "../lib/api-tokens";

const id = "a".repeat(64);
const other = "b".repeat(64);
const strings = new Proxy({}, { get: (_target, key) => String(key) });

test("scope approval reads only on load, rejects without mutation, and POSTs exactly the displayed one scope once", async () => {
  const win = new Window();
  const requests: { url: string; options?: RequestInit }[] = [];
  let finish: ((value: Response) => void) | undefined;
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      if (options?.method === "POST")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      const params = new URL(url, "https://test.invalid").searchParams;
      return Promise.resolve(
        Response.json({
          token: {
            id: params.get("id"),
            name: "Assistant",
            scopes: [...DEFAULT_TOKEN_SCOPES],
            expiresAt: null,
          },
          needScope: params.get("scope"),
          granted: false,
          canApprove: true,
        }),
      );
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  const click = (selector: string) =>
    host
      .querySelector(selector)!
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
  try {
    await act(async () =>
      root.render(<TokenScopeApproval id={id} scope="study" strings={strings} />),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options?.method).toBeUndefined();
    expect(host.textContent).toContain("Assistant");
    await act(() => click('[data-testid="scope-request-reject"]'));
    expect(requests).toHaveLength(1);
    expect(host.textContent).toContain("scopeRequestRejected");
    await act(async () =>
      root.render(<TokenScopeApproval key="next" id={other} scope="chat:ask" strings={strings} />),
    );
    await act(() => {
      click('[data-testid="scope-request-approve"]');
      click('[data-testid="scope-request-approve"]');
    });
    const posts = requests.filter((request) => request.options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.options!.body as string)).toEqual({ id: other, scope: "chat:ask" });
    expect(posts[0]!.url).toBe("/api/token/scopes");
    await act(async () =>
      finish!(Response.json({ ok: true, token: { id: other, scopes: ["chat:ask"] } })),
    );
    expect(host.querySelector('[data-testid="scope-request-approved"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});

test("a changed request ignores stale metadata and never approves a scope the account cannot grant", async () => {
  const win = new Window();
  const pending: ((value: Response) => void)[] = [];
  const requests: string[] = [];
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string) => {
      requests.push(url);
      return new Promise<Response>((resolve) => pending.push(resolve));
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await act(() => root.render(<TokenScopeApproval id={id} scope="study" strings={strings} />));
    await act(() => root.render(<TokenScopeApproval id={other} scope="eval" strings={strings} />));
    await act(async () =>
      pending[0]!(
        Response.json({
          token: { id, name: "Old request", scopes: [], expiresAt: null },
          needScope: "study",
          granted: false,
          canApprove: true,
        }),
      ),
    );
    expect(host.textContent).not.toContain("Old request");
    expect(host.querySelector('[data-testid="scope-request-approve"]')).toBeNull();
    await act(async () =>
      pending[1]!(
        Response.json({
          token: { id: other, name: "Current request", scopes: [], expiresAt: null },
          needScope: "eval",
          granted: true,
          canApprove: false,
          error: "dev-required",
        }),
      ),
    );
    const button = host.querySelector('[data-testid="scope-request-approve"]')!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("scopeRequestDevRequired");
    await act(() => button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never));
    expect(requests).toHaveLength(2);
    expect(host.querySelector('[data-testid="scope-request-approved"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});
