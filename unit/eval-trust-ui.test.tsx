import { expect, it } from "bun:test";
import { stubGlobals } from "./support/globals";
import { renderToStaticMarkup } from "react-dom/server";
import { DebugPairModal } from "../packages/debug-chat/src/DebugPairModal";
import { CHAT_LOCALES } from "../packages/debug-chat/src/chat-ui-locales";
import {
  EVAL_TRUST_CONTEXT,
  EVAL_TRUST_STRINGS,
  evalTrustStrings,
} from "../packages/debug-chat/src/eval-trust-strings";
import { parsePageMessage } from "@/lib/dev-eval";

it("declares all 16 locales with translation context and distinct explicit choices", () => {
  expect(Object.keys(EVAL_TRUST_STRINGS).sort()).toEqual([...CHAT_LOCALES].sort());
  for (const strings of Object.values(EVAL_TRUST_STRINGS)) {
    expect(Object.keys(strings).sort()).toEqual(Object.keys(EVAL_TRUST_CONTEXT).sort());
    expect(strings.temporary).not.toBe(strings.remember);
    expect(Object.values(strings).every((s) => s.trim().length > 0)).toBe(true);
  }
  expect(evalTrustStrings()).toEqual(EVAL_TRUST_STRINGS.en);
});
it("keeps finite approval selected and persistent trust unselected by default, never for friends or chat", () => {
  const props = {
    pending: { pair: "request", code: "1234", label: "terminal", at: 1, scope: "eval" as const },
    friend: false,
    pages: [],
    onAllow() {},
    onDeny() {},
  };
  const html = renderToStaticMarkup(<DebugPairModal {...props} />);
  expect(html).toContain(EVAL_TRUST_STRINGS.en.remember);
  expect(html).toMatch(/type="radio"[^>]*name="eval-trust"[^>]*checked=""/);
  expect((html.match(/checked=""/g) ?? []).length).toBe(1);
  expect(renderToStaticMarkup(<DebugPairModal {...props} friend />)).not.toContain(
    'name="eval-trust"',
  );
  expect(
    renderToStaticMarkup(
      <DebugPairModal {...props} pending={{ ...props.pending, scope: "chat" }} />,
    ),
  ).not.toContain('name="eval-trust"');
});
it("only exact true opts into remembered authority; old pages keep the old wire message", () => {
  const parse = (remember?: unknown) =>
    parsePageMessage(JSON.stringify({ type: "allow", pair: "request", remember }));
  expect(parse()).toEqual({ type: "allow", pair: "request" });
  expect(parse("true")).toEqual({ type: "allow", pair: "request" });
  expect(parse(true)).toEqual({ type: "allow", pair: "request", remember: true });
});

it("sends explicit remembered approval, resets on the next request and preserves finite page selection", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  try {
    const approvals: unknown[] = [];
    let denied = 0;
    const props = {
      pending: { pair: "first", code: "1234", label: "terminal", at: 1, scope: "eval" as const },
      friend: false,
      selfPage: "self",
      pages: [
        { id: "self", label: "/words · phone", at: 1 },
        { id: "other", label: "/books · laptop", at: 1 },
      ],
      onAllow: (pages: string[] | "all", remember?: boolean) => approvals.push({ pages, remember }),
      onDeny: () => {
        denied++;
      },
    };
    const click = (selector: string) =>
      act(() => (host.querySelector(selector) as unknown as { click(): void }).click());
    await act(() => root.render(<DebugPairModal {...props} />));
    await click('[data-testid="debug-modal-allow"]');
    expect(approvals.pop()).toEqual({ pages: ["self"], remember: false });
    await click('[data-page-id="other"]');
    await click('[data-testid="debug-modal-allow"]');
    expect(approvals.pop()).toEqual({ pages: "all", remember: false });
    await click('[data-page-id="other"]');
    await click('[data-testid="debug-modal-allow-all"]');
    expect(approvals.pop()).toEqual({ pages: "all", remember: undefined });
    await click('input[type="radio"]:not(:checked)');
    expect(host.textContent).toContain(EVAL_TRUST_STRINGS.en.scope);
    expect(host.querySelector('[data-testid="debug-modal-pages"]')).toBeNull();
    await click('[data-testid="debug-modal-allow"]');
    expect(approvals.pop()).toEqual({ pages: "all", remember: true });
    await click('input[type="radio"]:not(:checked)');
    expect(host.querySelector('[data-testid="debug-modal-pages"]')).not.toBeNull();
    await click('input[type="radio"]:not(:checked)');
    await act(() =>
      root.render(<DebugPairModal {...props} pending={{ ...props.pending, pair: "next" }} />),
    );
    expect(host.querySelector('[data-testid="debug-modal-pages"]')).not.toBeNull();
    await click('[data-testid="debug-modal-allow"]');
    expect(approvals.pop()).toEqual({ pages: ["self"], remember: false });
    await click('[data-testid="debug-modal-deny"]');
    expect(denied).toBe(1);
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});
