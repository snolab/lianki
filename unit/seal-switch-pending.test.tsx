import { expect, test } from "bun:test";
import { createElement, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { SealSwitch } from "@/app/components/SealSwitch";
import { mockIntlayer } from "./intlayer-mock";
import { stubGlobals } from "./support/globals";

mockIntlayer();

async function fixture(
  run: (
    host: HTMLElement,
    show: (node: React.ReactNode) => Promise<void>,
    click: () => Promise<void>,
  ) => Promise<void>,
) {
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    await run(
      host as never,
      async (node) => {
        await act(() => root.render(node));
      },
      async () => {
        await act(() => {
          host
            .querySelector("button")!
            .dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never);
        });
      },
    );
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
}

test("a switch awaits confirmation, prevents duplicate writes, then shows the confirmed state", async () => {
  let finish!: () => void,
    calls = 0;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function Setting() {
    const [checked, setChecked] = useState(false);
    return createElement(SealSwitch, {
      checked,
      "aria-label": "setting",
      onClick: async () => {
        calls++;
        await request;
        setChecked(true);
      },
    });
  }
  await fixture(async (host, show, click) => {
    await show(createElement(Setting));
    expect(host.querySelector(".lk-seal-pending")).toBeNull();
    await click();
    expect(host.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector("button")?.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("button")?.disabled).toBe(true);
    expect(host.querySelector(".lk-seal-pending")).not.toBeNull();
    await click();
    expect(calls).toBe(1);
    await act(async () => {
      finish();
      await request;
    });
    expect(host.querySelector("button")?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("button")?.hasAttribute("aria-busy")).toBe(false);
    expect(host.querySelector("button")?.disabled).toBe(false);
    expect(host.querySelector(".lk-seal-pending")).toBeNull();
  });
});

test("a handled save failure clears pending without changing the confirmed value", async () => {
  let fail!: (error: Error) => void,
    handled = false;
  const request = new Promise<void>((_, reject) => {
    fail = reject;
  });
  await fixture(async (host, show, click) => {
    await show(
      createElement(SealSwitch, {
        checked: false,
        "aria-label": "setting",
        onClick: () =>
          request.catch(() => {
            handled = true;
          }),
      }),
    );
    await click();
    await act(async () => {
      fail(new Error("request failed"));
      await request.catch(() => {});
    });
    expect(handled).toBe(true);
    expect(host.querySelector("button")?.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("button")?.disabled).toBe(false);
    expect(host.querySelector(".lk-seal-pending")).toBeNull();
  });
});

test("a synchronous local change has no artificial waiting phase", async () => {
  let calls = 0;
  await fixture(async (host, show, click) => {
    await show(
      createElement(SealSwitch, {
        checked: false,
        onClick: () => {
          calls++;
        },
      }),
    );
    await click();
    expect(calls).toBe(1);
    expect(host.querySelector("button")?.hasAttribute("aria-busy")).toBe(false);
    expect(host.querySelector(".lk-seal-pending")).toBeNull();
  });
});

test("parent pending and permission-disabled remain distinct", async () => {
  await fixture(async (host, show) => {
    await show(createElement(SealSwitch, { checked: true, pending: true }));
    expect(host.querySelector(".lk-seal-pending")).not.toBeNull();
    expect(host.querySelector("button")?.disabled).toBe(true);
    await show(createElement(SealSwitch, { checked: true, disabled: true }));
    expect(host.querySelector(".lk-seal-pending")).toBeNull();
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
});
