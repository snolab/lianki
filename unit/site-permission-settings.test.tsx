/** First-party permission controls with synthetic fetches; no real account or site grant is touched. */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import SitePermissions, {
  type SitePermissionLabels,
} from "../app/(app)/chat/sites/SitePermissions";
import { mockIntlayer } from "./intlayer-mock";
import { stubGlobals } from "./support/globals";
mockIntlayer();
const labels: SitePermissionLabels = {
  title: "Synthetic website permissions",
  body: "Synthetic exact-site permissions explanation",
  origin: "Synthetic origin",
  originHint: "Synthetic separate-subdomain hint",
  add: "Synthetic add",
  pageRead: "Synthetic selected text",
  deny: "Synthetic denied",
  error: "Synthetic save failed",
  loading: "Synthetic loading",
  empty: "Synthetic empty",
  site: "Synthetic website",
  advancedLink: "Synthetic first-party permission",
  retry: "Synthetic retry",
};
const origin = "https://example.test";
const grant = (enabled: boolean, revision = 1, site = origin) => ({
  origin: site,
  scope: "page.read",
  enabled,
  revision,
});
type Pending = {
  url: string;
  init: RequestInit;
  body: unknown;
  resolve(response: Response): void;
  reject(reason: Error): void;
};
async function fixture(
  run: (f: {
    win: Window;
    host: ReturnType<Window["document"]["createElement"]>;
    requests: Pending[];
    answer(index: number, body: unknown, status?: number): Promise<void>;
    reject(index: number): Promise<void>;
    input(value: string): Promise<void>;
    submit(): void;
    button(label: string): ReturnType<Window["document"]["createElement"]>;
    unmount(): Promise<void>;
  }) => Promise<void>,
  url = "https://lianki.com/chat/sites",
) {
  const win = new Window({ url });
  const requests: Pending[] = [];
  const restore = stubGlobals({
    window: win,
    document: win.document,
    navigator: win.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: ((url: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({
          url: String(url),
          init,
          body: JSON.parse(String(init.body)),
          resolve,
          reject,
        });
      })) as typeof fetch,
  });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;
  const settle = async (fn: () => void) =>
    act(async () => {
      fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  const unmount = async () => {
    if (root) {
      const current = root;
      root = undefined;
      await act(() => current.unmount());
    }
  };
  try {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(host as never);
    await act(() => root!.render(createElement(SitePermissions, { labels })));
    await run({
      win,
      host,
      requests,
      answer: (index, body, status = 200) =>
        settle(() => requests[index].resolve(Response.json(body, { status }))),
      reject: (index) => settle(() => requests[index].reject(Error("synthetic network failure"))),
      input: (value) =>
        settle(() => {
          const field = host.querySelector("input")!;
          Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
            field,
            value,
          );
          field.dispatchEvent(new win.Event("input", { bubbles: true }));
        }),
      submit: () => {
        host
          .querySelector("form")!
          .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      },
      button: (label) => {
        const button = [...host.querySelectorAll("button")].find(
          (node) => node.textContent === label,
        );
        expect(button).toBeDefined();
        return button!;
      },
      unmount,
    });
  } finally {
    await unmount();
    restore();
    await win.happyDOM.abort();
  }
}
test("loads only through the fixed first-party JSON endpoint, adds disabled exact origins, then enables and revokes with a SealSwitch", async () => {
  await fixture(async (f) => {
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].body).toEqual({ op: "list" });
    expect(f.host.textContent).toContain(labels.loading);
    await f.answer(0, { ok: true, kind: "list", grants: [] });
    expect(f.host.textContent).toContain(labels.empty);
    await f.input(origin);
    expect(f.button(labels.add).hasAttribute("disabled")).toBe(false);
    await act(() => f.submit());
    expect(f.requests[1].body).toEqual({ op: "set", origin, scope: "page.read", enabled: false });
    await f.answer(1, { ok: true, kind: "grant", grant: grant(false) });
    const control = () => f.host.querySelector('[role="switch"]')!;
    expect(control().getAttribute("aria-label")).toBe(labels.pageRead + " — " + origin);
    expect(control().getAttribute("aria-checked")).toBe("false");
    expect(control().querySelector('[data-word="on"]')).not.toBeNull();
    expect(control().querySelector('[data-word="off"]')).not.toBeNull();
    await act(() => (control() as unknown as { click(): void }).click());
    expect(f.requests[2].body).toEqual({ op: "set", origin, scope: "page.read", enabled: true });
    expect(control().getAttribute("aria-checked")).toBe("false");
    await f.answer(2, { ok: true, kind: "grant", grant: grant(true, 2) });
    expect(control().getAttribute("aria-checked")).toBe("true");
    await act(() => (control() as unknown as { click(): void }).click());
    expect(f.requests[3].body).toEqual({ op: "set", origin, scope: "page.read", enabled: false });
    await f.answer(3, { ok: true, kind: "grant", grant: grant(false, 3) });
    expect(control().getAttribute("aria-checked")).toBe("false");
    for (const req of f.requests) {
      expect(req.url).toBe("/api/chat/site-permissions");
      expect(req.init.method).toBe("POST");
      expect(req.init.credentials).toBe("same-origin");
      expect(new Headers(req.init.headers).get("content-type")).toBe("application/json");
      expect(new Headers(req.init.headers).has("authorization")).toBe(false);
      expect(req.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
test("invalid origins stay disabled and URL-prefilled exact origins do not auto-grant", async () => {
  await fixture(
    async (f) => {
      expect(f.host.querySelector("input")?.value).toBe(origin);
      expect(f.requests.map((req) => req.body)).toEqual([{ op: "list" }]);
      await f.answer(0, { ok: true, kind: "list", grants: [] });
      for (const value of [
        "",
        "http://example.test",
        origin + "/path",
        origin + "/",
        "https://*.example.test",
        "https://user@example.test",
        "https://EXAMPLE.test",
      ]) {
        await f.input(value);
        expect(f.button(labels.add).hasAttribute("disabled")).toBe(true);
        await act(() => f.submit());
        expect(f.requests).toHaveLength(1);
      }
    },
    "https://lianki.com/chat/sites?origin=" + encodeURIComponent(origin),
  );
  await fixture(
    async (f) => {
      expect(f.host.querySelector("input")?.value).toBe("");
      await f.answer(0, { ok: true, kind: "list", grants: [] });
    },
    "https://lianki.com/chat/sites?origin=" + encodeURIComponent(origin + "/path"),
  );
});
test("pending list/add/switch requests block duplicate writes and keep the confirmed state visible", async () => {
  await fixture(async (f) => {
    await f.input(origin);
    expect(f.button(labels.add).hasAttribute("disabled")).toBe(true);
    await act(() => {
      f.submit();
      f.submit();
    });
    expect(f.requests).toHaveLength(1);
    await f.answer(0, { ok: true, kind: "list", grants: [] });
    await act(() => {
      f.submit();
      f.submit();
    });
    expect(f.requests).toHaveLength(2);
    expect(f.button(labels.add).hasAttribute("disabled")).toBe(true);
    await f.answer(1, { ok: true, kind: "grant", grant: grant(false) });
    const control = f.host.querySelector('[role="switch"]') as unknown as {
      click(): void;
      getAttribute(name: string): string | null;
      disabled: boolean;
    };
    await act(() => {
      control.click();
      control.click();
    });
    expect(f.requests).toHaveLength(3);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("false");
    await f.answer(2, { ok: true, kind: "grant", grant: grant(true, 2) });
    expect(control.disabled).toBe(false);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });
});
test("a failed revoke leaves the confirmed grant on and retry reloads authoritative state", async () => {
  await fixture(async (f) => {
    await f.answer(0, { ok: true, kind: "list", grants: [grant(true)] });
    const control = () =>
      f.host.querySelector('[role="switch"]') as unknown as {
        click(): void;
        getAttribute(name: string): string | null;
      };
    await act(() => control().click());
    await f.answer(1, { ok: false, error: "unavailable" }, 503);
    expect(control().getAttribute("aria-checked")).toBe("true");
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe("⚠ " + labels.error);
    await act(() => f.button(labels.retry).click());
    expect(f.requests[2].body).toEqual({ op: "list" });
    await f.answer(2, { ok: true, kind: "list", grants: [grant(false, 2)] });
    expect(control().getAttribute("aria-checked")).toBe("false");
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe("");
    expect(
      [...f.host.querySelectorAll("button")].some((node) => node.textContent === labels.retry),
    ).toBe(false);
  });
});
test("network errors and malformed public results show retry without inventing a grant", async () => {
  await fixture(async (f) => {
    await f.reject(0);
    expect(f.host.textContent).toContain(labels.error);
    await act(() => f.button(labels.retry).click());
    await f.answer(1, {
      ok: true,
      kind: "selection",
      selection: { text: "synthetic", title: "synthetic", url: origin },
      revision: 1,
    });
    expect(f.host.textContent).toContain(labels.error);
    expect(f.host.querySelector('[role="switch"]')).toBeNull();
    await act(() => f.button(labels.retry).click());
    await f.answer(2, {
      ok: true,
      kind: "grant",
      grant: { ...grant(true), scope: "page.execute" },
    });
    expect(f.host.textContent).toContain(labels.error);
    expect(f.host.querySelector('[role="switch"]')).toBeNull();
    await act(() => f.button(labels.retry).click());
    await f.answer(3, { ok: true, kind: "list", grants: [] });
    expect(f.host.textContent).toContain(labels.empty);
  });
});
test("unmount aborts the outstanding request and ignores its later response", async () => {
  await fixture(async (f) => {
    const signal = f.requests[0].init.signal!;
    expect(signal.aborted).toBe(false);
    await f.unmount();
    expect(signal.aborted).toBe(true);
    await f.answer(0, { ok: true, kind: "list", grants: [grant(true)] });
    expect(f.host.children).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
  });
});

test("a single-site save preserves other confirmed permissions and keeps origins sorted", async () => {
  await fixture(async (f) => {
    const other = "https://z.example.test";
    await f.answer(0, { ok: true, kind: "list", grants: [grant(true, 1, other)] });
    await f.input(origin);
    await act(() => f.submit());
    await f.answer(1, { ok: true, kind: "grant", grant: grant(false, 2) });
    const rows = [...f.host.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(origin);
    expect(rows[0].querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(rows[1].textContent).toContain(other);
    expect(rows[1].querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });
});
