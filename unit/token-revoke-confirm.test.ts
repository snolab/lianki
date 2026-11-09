/**
 * Settings → API tokens: Revoke asks first (app/(app)/preferences/RevokeConfirm.tsx).
 * The first click only opens "Revoke <name>? Apps using it stop working at
 * once." with Revoke and Cancel; Cancel takes the focus, Esc backs out, and
 * only the confirming Revoke deletes. The component is stateless, so its
 * element tree is walked here and its handlers called directly.
 */
import { describe, expect, it, mock } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  escapeCancels,
  RevokeConfirm,
  revokeQuestion,
} from "@/app/(app)/preferences/RevokeConfirm";
import apiTokens from "@/app/components/api-tokens.content";

const labels = {
  revoke: "Revoke",
  question: "Revoke {name}? Apps using it stop working at once.",
  cancel: "Cancel",
};

type Props = Parameters<typeof RevokeConfirm>[0];
function setup(over: Partial<Props> = {}) {
  const props: Props = {
    id: "t1",
    name: "codex",
    confirming: false,
    labels,
    onAsk: mock(() => {}),
    onConfirm: mock(() => {}),
    onCancel: mock(() => {}),
    ...over,
  };
  return { props, tree: RevokeConfirm(props) as ReactElement };
}

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
/** Every element in the tree, depth first. */
function all(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...all(el.props.children)];
}
const byTestId = (tree: ReactNode, id: string) =>
  all(tree).find((e) => e.props["data-testid"] === id);

describe("revokeQuestion", () => {
  it("puts the token's name in the question, every {name}", () => {
    expect(revokeQuestion(labels.question, "codex")).toBe(
      "Revoke codex? Apps using it stop working at once.",
    );
    expect(revokeQuestion("{name} / {name}", "a")).toBe("a / a");
  });

  it("keeps a name with markup as plain text (React escapes it)", () => {
    const html = renderToStaticMarkup(
      createElement(RevokeConfirm, { ...setup().props, confirming: true, name: "<b>x</b>" }),
    );
    expect(html).toContain("Revoke &lt;b&gt;x&lt;/b&gt;?");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("RevokeConfirm", () => {
  it("first shows only the row's Revoke button, which asks — it never deletes", () => {
    const { props, tree } = setup();
    expect(byTestId(tree, "token-revoke-confirm")).toBeUndefined();
    const btn = byTestId(tree, "token-revoke")!;
    expect(btn.props.children).toBe("Revoke");
    expect(btn.props.autoFocus).toBe(false);
    (btn.props.onClick as () => void)();
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("asks with the name, Cancel focused, as a labelled group", () => {
    const { tree } = setup({ confirming: true });
    const group = byTestId(tree, "token-revoke-confirm")!;
    expect(group.props.role).toBe("group");
    expect(group.props["aria-labelledby"]).toBe("revoke-q-t1");
    const q = all(tree).find((e) => e.props.id === "revoke-q-t1")!;
    expect(q.props.children).toBe("Revoke codex? Apps using it stop working at once.");
    expect(byTestId(tree, "token-revoke-cancel")!.props.autoFocus).toBe(true);
    expect(byTestId(tree, "token-revoke-yes")!.props.autoFocus).toBeUndefined();
    expect(byTestId(tree, "token-revoke")).toBeUndefined();
    const html = renderToStaticMarkup(tree);
    expect(html.indexOf("Cancel")).toBeLessThan(html.lastIndexOf(">Revoke<"));
  });

  it("Revoke in the question confirms; Cancel backs out", () => {
    const { props, tree } = setup({ confirming: true });
    (byTestId(tree, "token-revoke-yes")!.props.onClick as () => void)();
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    (byTestId(tree, "token-revoke-cancel")!.props.onClick as () => void)();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("Esc anywhere in the question cancels; other keys do nothing", () => {
    const { props, tree } = setup({ confirming: true });
    const onKeyDown = byTestId(tree, "token-revoke-confirm")!.props.onKeyDown as (e: {
      key: string;
      preventDefault: () => void;
    }) => void;
    const preventDefault = mock(() => {});
    onKeyDown({ key: "Enter", preventDefault });
    expect(props.onCancel).not.toHaveBeenCalled();
    onKeyDown({ key: "Escape", preventDefault });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("escapeCancels works without preventDefault", () => {
    const cancel = mock(() => {});
    escapeCancels(cancel)({ key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("while revoking, both buttons are disabled (no double delete)", () => {
    const { tree } = setup({ confirming: true, busy: true });
    expect(byTestId(tree, "token-revoke-yes")!.props.disabled).toBe(true);
    expect(byTestId(tree, "token-revoke-cancel")!.props.disabled).toBe(true);
  });

  it("after Cancel the row's Revoke gets the focus back", () => {
    const { tree } = setup({ focusRevoke: true });
    expect(byTestId(tree, "token-revoke")!.props.autoFocus).toBe(true);
  });
});

describe("the confirm strings", () => {
  type Leaf = { translation: Record<string, string> };
  const c = apiTokens.content as unknown as Record<string, Leaf>;
  it("every locale keeps {name} in the question", () => {
    const tr = c.revokeConfirm.translation;
    expect(Object.keys(tr)).toHaveLength(16);
    for (const [loc, text] of Object.entries(tr))
      expect([loc, text.includes("{name}")]).toEqual([loc, true]);
  });

  it("Cancel never repeats the locale's Revoke word (it must read as 'go back')", () => {
    const cancel = c.revokeCancel.translation;
    const revoke = c.revoke.translation;
    expect(Object.keys(cancel)).toHaveLength(16);
    for (const loc of Object.keys(cancel))
      expect([loc, cancel[loc].includes(revoke[loc])]).toEqual([loc, false]);
  });
});
