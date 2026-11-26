import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import { TokenRename } from "../app/(app)/my/preferences/TokenRename";
const labels = {
  rename: "Rename",
  save: "Save name",
  cancel: "Keep current name",
  name: "Token name",
  hint: "Only the name changes.",
  invalid: "Invalid name",
  failed: "Try again",
};
const id = "a".repeat(64);

test("inline token editor cancels without a request, then sends only id/name and accepts only its own response", async () => {
  const win = new Window();
  const requests: { url: string; options?: RequestInit }[] = [];
  const names: string[] = [];
  let finish!: (r: Response) => void;
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      return new Promise<Response>((r) => {
        finish = r;
      });
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as never);
  const click = (label: string) => {
    const b = [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    b.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
  };
  const edit = (value: string) => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
  };
  const submit = () =>
    host
      .querySelector("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as never);
  try {
    await act(() =>
      root.render(
        <TokenRename id={id} name="Before" labels={labels} onRenamed={(n) => names.push(n)} />,
      ),
    );
    await act(() => click("Rename"));
    expect(host.querySelector("input")!.value).toBe("Before");
    await act(() => edit("Discard"));
    await act(() => click("Keep current name"));
    expect(requests).toHaveLength(0);
    await act(() => click("Rename"));
    expect(host.querySelector("input")!.value).toBe("Before");
    await act(() => edit("  After  "));
    await act(() => {
      submit();
      submit();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/token");
    expect(requests[0]!.options!.method).toBe("PATCH");
    expect(JSON.parse(requests[0]!.options!.body as string)).toEqual({ id, name: "After" });
    expect(host.querySelector("input")!.disabled).toBe(true);
    await act(async () => {
      finish(Response.json({ ok: true, id, name: "After" }));
    });
    expect(names).toEqual(["After"]);
    expect(host.querySelector("form")).toBeNull();
  } finally {
    await act(() => root.unmount());
    restore();
    win.happyDOM.abort();
  }
});

test("failed or mismatched rename stays editable and never changes the displayed row", async () => {
  const win = new Window();
  let result: Response | Error = Response.json({ ok: true, id: "b".repeat(64), name: "Wrong" });
  let calls = 0;
  const names: string[] = [];
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as never);
  const submit = () =>
    host
      .querySelector("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as never);
  try {
    await act(() =>
      root.render(
        <TokenRename id={id} name="Before" labels={labels} onRenamed={(n) => names.push(n)} />,
      ),
    );
    await act(() =>
      host
        .querySelector("button")!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never),
    );
    await act(async () => {
      submit();
    });
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Try again");
    expect(names).toEqual([]);
    result = Response.json({ error: "name: invalid" }, { status: 400 });
    await act(async () => {
      submit();
    });
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Invalid name");
    expect(calls).toBe(2);
    expect(host.querySelector("input")!.value).toBe("Before");
    result = new Response("invalid JSON", { status: 200 });
    await act(async () => {
      submit();
    });
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Try again");
    result = new Error("offline");
    await act(async () => {
      submit();
    });
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Try again");
    expect(names).toEqual([]);
    const input = host.querySelector("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        " ",
      );
      input.dispatchEvent(new win.Event("input", { bubbles: true }) as never);
    });
    await act(async () => {
      submit();
    });
    expect(calls).toBe(4);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Invalid name");
  } finally {
    await act(() => root.unmount());
    restore();
    win.happyDOM.abort();
  }
});
