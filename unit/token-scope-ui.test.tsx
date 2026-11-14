import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mockIntlayer } from "./intlayer-mock";
mockIntlayer("en");
beforeEach(() => mockIntlayer("en"));
const { default: TokenScopeClient, TokenScopeApproval } =
  await import("../app/(app)/my/tokens/scopes/TokenScopeClient");
const { PermissionPicker, ExpiryPicker, expiryBody, textOf } =
  await import("../app/components/TokenPickers");
import { stubGlobals } from "./support/globals";
import { DEFAULT_TOKEN_SCOPES, EVAL_MAX_DAYS } from "../lib/api-tokens";

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

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Real React events/effects, isolated from the generated intlayer runtime and network. */
async function withUi(
  fetcher: Fetcher,
  run: (ui: {
    host: HTMLElement;
    win: Window;
    render: (node: import("react").ReactNode) => Promise<void>;
    click: (selector: string) => Promise<void>;
    act: typeof import("react").act;
  }) => Promise<void>,
) {
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    fetch: fetcher,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await run({
      host: host as never,
      win,
      act,
      render: async (node) => {
        await act(async () => root.render(node));
      },
      click: async (selector) => {
        await act(async () => {
          const el = host.querySelector(selector);
          expect(el).not.toBeNull();
          el!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
        });
      },
    });
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
}
const view = (patch = {}) => ({
  token: { id, name: "Assistant", scopes: [], expiresAt: null },
  needScope: "study",
  granted: false,
  canApprove: true,
  ...patch,
});

test("approval handles invalid links, sign-in, malformed metadata, unavailable requests and fetch failure", async () => {
  let calls = 0;
  let reply: () => Promise<Response> = async () => Response.json({}, { status: 401 });
  await withUi(
    (async () => {
      calls++;
      return reply();
    }) as Fetcher,
    async ({ host, render }) => {
      await render(<TokenScopeClient id={null} scope={null} />);
      expect(calls).toBe(0);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      await render(<TokenScopeClient key="login" id={id} scope="study" />);
      expect(host.querySelector('a[href="/sign-in"]')?.getAttribute("target")).toBe("_blank");
      for (const [key, get] of [
        ["missing", async () => Response.json({}, { status: 404 })],
        ["wrong-token", async () => Response.json(view({ token: { id: other } }))],
        ["wrong-scope", async () => Response.json(view({ needScope: "eval" }))],
        ["bad-shape", async () => Response.json(view({ granted: "yes" }))],
        ["bad-error", async () => Response.json(view({ error: "unknown" }))],
        [
          "network",
          async () => {
            throw new Error("offline");
          },
        ],
        ["bad-json", async () => new Response("{")],
      ] as const) {
        reply = get;
        await render(<TokenScopeApproval key={key} id={id} scope="study" strings={strings} />);
        expect(host.querySelector('[role="alert"]')?.textContent).toBe("scopeRequestUnavailable");
        expect(host.querySelector('[data-testid="scope-request-approve"]')).toBeNull();
      }
    },
  );
});

test("approval describes expiry denial and already-approved permission without POSTing", async () => {
  let data = view({ canApprove: false, error: "expiry-too-long" });
  await withUi((async () => Response.json(data)) as Fetcher, async ({ host, render }) => {
    await render(
      <TokenScopeApproval
        id={id}
        scope="study"
        strings={{ ...strings, scopeRequestExpiry: "Expiry {days}" }}
      />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(`Expiry ${EVAL_MAX_DAYS}`);
    expect(host.querySelector("button")?.disabled).toBe(true);
    data = view({ granted: true });
    await render(<TokenScopeApproval key="granted" id={id} scope="study" strings={strings} />);
    expect(host.querySelector('[data-testid="scope-request-approved"]')).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
    data = view({ canApprove: false });
    await render(<TokenScopeApproval key="denied" id={id} scope="study" strings={strings} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("scopeRequestUnavailable");
  });
});

test("approval rejects failed or mismatched POST results and allows an explicit retry", async () => {
  let post: () => Promise<Response> = async () => {
    throw new Error("offline");
  };
  await withUi(
    (async (_url, options) =>
      options?.method === "POST" ? post() : Response.json(view())) as Fetcher,
    async ({ host, render, click }) => {
      await render(<TokenScopeApproval id={id} scope="study" strings={strings} />);
      for (const result of [
        async () => {
          throw new Error("offline");
        },
        async () => new Response("{", { status: 500 }),
        async () => Response.json({ ok: false }),
        async () => Response.json({ ok: true, token: { id: other, scopes: ["study"] } }),
        async () => Response.json({ ok: true, token: { id, scopes: [] } }),
      ]) {
        post = result;
        await click('[data-testid="scope-request-approve"]');
        expect(host.querySelector('[role="alert"]')?.textContent).toBe("scopeRequestFailed");
        expect(host.querySelector("button")?.disabled).toBe(false);
      }
      post = async () => Response.json({ ok: true, token: { id, scopes: ["study"] } });
      await click('[data-testid="scope-request-approve"]');
      expect(host.querySelector('[data-testid="scope-request-approved"]')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );
});

test("a pending approval cannot alter another request after navigation", async () => {
  let finish!: (response: Response) => void;
  await withUi(
    (async (url, options) =>
      options?.method === "POST"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Response.json(
            view({
              token: {
                id: new URL(String(url), "https://test.invalid").searchParams.get("id"),
                name: "Current",
                scopes: [],
                expiresAt: null,
              },
            }),
          )) as Fetcher,
    async ({ host, render, click, act }) => {
      await render(<TokenScopeApproval id={id} scope="study" strings={strings} />);
      await click('[data-testid="scope-request-approve"]');
      expect(host.querySelector("button")?.disabled).toBe(true);
      await render(<TokenScopeApproval id={other} scope="study" strings={strings} />);
      await act(async () => finish(Response.json({ ok: true, token: { id, scopes: ["study"] } })));
      expect(host.querySelector('[data-testid="scope-request-approved"]')).toBeNull();
      expect(host.querySelector("button")?.disabled).toBe(false);
    },
  );
});

test("permission picker toggles only offered scopes and preserves other selections", async () => {
  await withUi(fetch, async ({ host, render, click }) => {
    const changes: string[][] = [];
    const onChange = (value: import("../lib/api-tokens").ScopeId[]) => changes.push(value);
    await render(<PermissionPicker value={["chat:read"]} onChange={onChange} />);
    expect(host.querySelector('[data-scope="eval"]')).toBeNull();
    expect(host.textContent).toContain("never");
    await click('[data-scope="study"]');
    expect(changes.at(-1)).toEqual(["chat:read", "study"]);
    await click('[data-scope="chat:read"]');
    expect(changes.at(-1)).toEqual([]);
    await render(
      <PermissionPicker
        value={["eval"]}
        onChange={onChange}
        offered={["eval", "progress"]}
        disabled
      />,
    );
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelectorAll("input")).toHaveLength(2);
    expect(host.querySelector('[data-scope="eval"]')?.getAttribute("type")).toBe("checkbox");
  });
});

test("expiry picker switches durations and custom dates and serializes only selected expiry", async () => {
  await withUi(fetch, async ({ host, render, click, act, win }) => {
    const changes: import("../app/components/TokenPickers").Expiry[] = [];
    const onChange = (value: import("../app/components/TokenPickers").Expiry) =>
      changes.push(value);
    await render(<ExpiryPicker value={null} onChange={onChange} />);
    const buttons = () => [...host.querySelectorAll("button")];
    await click("button");
    expect(changes.at(-1)).toEqual({ days: 7 });
    await render(<ExpiryPicker value={{ days: 7 }} onChange={onChange} />);
    expect(buttons()[0]?.getAttribute("aria-pressed")).toBe("true");
    await act(() =>
      buttons()
        .at(-1)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never),
    );
    expect(changes.at(-1)).toEqual({ date: "" });
    await render(<ExpiryPicker value={{ date: "2030-01-02" }} onChange={onChange} disabled />);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelector("input")?.value).toBe("2030-01-02");
    expect(host.querySelector("input")?.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(host.querySelector("input")?.getAttribute("max")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await render(<ExpiryPicker value={{ date: "2030-01-02" }} onChange={onChange} />);
    await act(() =>
      buttons()
        .at(-1)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never),
    );
    expect(changes.at(-1)).toEqual({ date: "2030-01-02" });
    // React's date change plugin is exercised with the native value setter.
    await act(() => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "2030-02-03",
      );
      input.dispatchEvent(new win.Event("change", { bubbles: true }) as never);
    });
    expect(changes.at(-1)).toEqual({ date: "2030-02-03" });
  });
  expect(expiryBody(null)).toBeNull();
  expect(expiryBody({ days: 30 })).toEqual({ days: 30 });
  expect(expiryBody({ date: "" })).toBeNull();
  expect(expiryBody({ date: "2030-02-03" })).toEqual({ date: "2030-02-03" });
  expect(textOf("plain")).toBe("plain");
  expect(textOf({ value: "node" })).toBe("node");
  expect(textOf(null)).toBe("");
});
