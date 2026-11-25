/**
 * A script-free HTML widget drawn inline (html-inline.ts sanitizes it). Forms
 * work as written, except that a submit never leaves the page: it becomes his
 * line, "↳ <action>: name=value, …", sent in his own thread to the agent that
 * posted it (host.onSubmit). Links open through the chat's own link menu.
 */
import { createElement, type FormEvent, type ReactNode, useId, useMemo } from "react";
import { formLine, inlineHtml, type InlineNode } from "./html-inline";
import { HtmlWidget } from "./HtmlWidget";
import type { WidgetHost } from "./MessageWidget";
import { ChatLink } from "./RichText";

const RULE = "light-dark(oklch(0.5 0.01 260 / 0.35), oklch(0.85 0.01 260 / 0.35))";
const VOID = new Set(["br", "hr", "img", "input"]);

/** React's names for the attributes the sanitizer keeps. */
const REACT_ATTR: Record<string, string> = {
  for: "htmlFor",
  colspan: "colSpan",
  rowspan: "rowSpan",
  maxlength: "maxLength",
  readonly: "readOnly",
  formaction: "data-formaction",
  formtarget: "data-formtarget",
  formmethod: "data-formmethod",
  action: "data-action",
  method: "data-method",
  target: "data-target",
};
const BOOL = new Set(["checked", "disabled", "required", "readonly", "multiple", "selected", "open"]);

function props(n: Extract<InlineNode, { tag: string }>, key: string): Record<string, unknown> {
  const p: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(n.attrs)) {
    const name = REACT_ATTR[k] ?? k;
    if (BOOL.has(k)) {
      // Uncontrolled: his edits stay his.
      if (k === "checked") p.defaultChecked = true;
      else if (k === "selected") continue;
      else p[name] = true;
    } else if (k === "value" && (n.tag === "input" || n.tag === "textarea")) {
      if (n.attrs.type === "submit" || n.attrs.type === "button" || n.attrs.type === "reset")
        p.value = v;
      else p.defaultValue = v;
    } else p[name] = v;
  }
  if (n.tag === "select") {
    const sel = n.children.find(
      (c) => "tag" in c && c.tag === "option" && "selected" in c.attrs,
    ) as Extract<InlineNode, { tag: string }> | undefined;
    if (sel) p.defaultValue = sel.attrs.value ?? "";
  }
  if (n.style) p.style = n.style;
  return p;
}

function els(nodes: InlineNode[], onSubmit: (e: FormEvent<HTMLFormElement>) => void, prefix = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`;
    if ("text" in n) return n.text;
    if (n.tag === "a")
      return n.attrs.href ? (
        <ChatLink key={key} href={n.attrs.href}>
          {els(n.children, onSubmit, `${key}.`)}
        </ChatLink>
      ) : (
        <span key={key}>{els(n.children, onSubmit, `${key}.`)}</span>
      );
    const p = props(n, key);
    if (n.tag === "form") p.onSubmit = onSubmit;
    if (n.tag === "textarea") {
      p.defaultValue = n.children.map((c) => ("text" in c ? c.text : "")).join("");
      return createElement("textarea", p);
    }
    if (VOID.has(n.tag)) return createElement(n.tag, p);
    return createElement(n.tag, p, ...els(n.children, onSubmit, `${key}.`));
  });
}

export function HtmlInline({ html, host }: { html: string; host: WidgetHost }) {
  const id = useId().replace(/[^\w-]/g, "");
  const nodes = useMemo(() => inlineHtml(html, `lkw${id}-`), [html, id]);
  // Script inside: the sandboxed frame instead.
  if (!nodes) return <HtmlWidget html={html} host={host} />;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Never a navigation, a new window or a request: his line instead.
    e.preventDefault();
    e.stopPropagation();
    const form = e.currentTarget;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const action =
      submitter?.getAttribute("data-formaction") ||
      form.getAttribute("data-action") ||
      form.getAttribute("name") ||
      "submit";
    const fields: [string, string][] = [];
    try {
      new FormData(form, submitter ?? undefined).forEach((v, k) => {
        if (typeof v === "string") fields.push([k, v]);
      });
    } catch {
      new FormData(form).forEach((v, k) => {
        if (typeof v === "string") fields.push([k, v]);
      });
    }
    host.onSubmit(formLine(action, fields));
  };
  return (
    <div
      data-testid="debug-chat-html-inline"
      className="pointer-events-auto my-1 max-h-[70vh] max-w-full overflow-auto rounded-lg border p-2 [contain:content]"
      style={{ borderColor: RULE }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {els(nodes, onSubmit)}
    </div>
  );
}
