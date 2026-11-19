import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { selectionLocation } from "../packages/debug-chat/src/selection-location";
import { createSelectionMemory, isSensitive, type SelectionDoc } from "@lianki/debug-chat/attach";
import { MAX_SELECTION, MAX_SELECTION_NEARBY, cleanContext } from "@lianki/debug-chat/wire";
import { parsePageMessage } from "@/lib/dev-eval";
import { chatLine } from "@/scripts/dev/node-args";

async function page(
  run: (doc: Document, select: (selector: string, start: number, end: number) => Range) => void,
) {
  const win = new Window();
  // happy-dom has no layout. Supply visible boxes; browser QA checks actual
  // geometry, while CSS/hidden-attribute checks still use the DOM's styles.
  Object.defineProperty(win.Element.prototype, "getClientRects", {
    value() {
      return [{ x: 0, y: 0, width: 100, height: 20 }];
    },
    configurable: true,
  });
  const doc = win.document as unknown as Document;
  const select = (selector: string, start: number, end: number) => {
    const range = doc.createRange(),
      node = doc.querySelector(selector)!.firstChild!;
    range.setStart(node, start);
    range.setEnd(node, end);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
    return range;
  };
  try {
    run(doc, select);
  } finally {
    await win.happyDOM.close();
  }
}
const excluded = (el: Element) =>
  isSensitive(el) || !!el.closest("[data-debug-chat],[data-lk-chat-host],[data-lk-private-screen]");

test("same words in different paragraphs retain distinct source locations and headings", async () => {
  await page((doc, select) => {
    doc.body.innerHTML =
      '<main><section><h2>First section</h2><p id="first">before repeated after</p></section><section><h2>Second section</h2><p id="second">other repeated ending</p></section></main>';
    select("#first", 7, 15);
    const first = selectionLocation(doc, excluded)!;
    expect(first).toMatchObject({
      kind: "dom",
      selector: "#first",
      heading: "First section",
      before: "before ",
      after: " after",
      start: 7,
      end: 15,
    });
    select("#second", 6, 14);
    expect(selectionLocation(doc, excluded)).toMatchObject({
      selector: "#second",
      heading: "Second section",
      start: 6,
      end: 14,
    });
    expect(selectionLocation(doc, excluded)?.selector).not.toBe(first.selector);
  });
});

test("geometry is document CSS pixels and includes viewport and scroll at selection time", async () => {
  await page((doc, select) => {
    doc.body.innerHTML = '<p id="p">select this</p>';
    const range = select("#p", 0, 6);
    Object.defineProperty(doc.defaultView!, "scrollY", { value: 400, configurable: true });
    range.getBoundingClientRect = () =>
      ({ left: 12.345, top: 30, width: 88, height: 20 }) as DOMRect;
    const out = selectionLocation(doc, excluded)!;
    expect(out.rect).toEqual({ x: 12.35, y: 430, width: 88, height: 20 });
    expect(out.viewport?.scrollY).toBe(400);
  });
});

test("long selections cap the quoted range and surrounding text", async () => {
  await page((doc, select) => {
    doc.body.innerHTML = `<p id="p">${"a".repeat(300)}${"x".repeat(MAX_SELECTION + 50)}${"z".repeat(300)}</p>`;
    select("#p", 300, 300 + MAX_SELECTION + 50);
    const out = selectionLocation(doc, excluded)!;
    expect(out.start).toBe(300);
    expect(out.end).toBe(300 + MAX_SELECTION);
    expect(out.before).toHaveLength(MAX_SELECTION_NEARBY);
    expect(out.after).toHaveLength(MAX_SELECTION_NEARBY);
    expect(out.after).toStartWith("x".repeat(50));
  });
});

test("fields attach offsets and a locator without copying their unselected value", async () => {
  await page((doc) => {
    doc.body.innerHTML = '<textarea id="draft">private prefix quote private suffix</textarea>';
    const field = doc.querySelector("textarea")!;
    field.focus();
    field.setSelectionRange(15, 20);
    const out = selectionLocation(doc, excluded)!;
    expect(out).toMatchObject({ kind: "field", selector: "#draft", start: 15, end: 20 });
    expect(out.before).toBeUndefined();
    expect(out.after).toBeUndefined();
    field.setAttribute("data-sensitive", "");
    expect(selectionLocation(doc, excluded)).toBeUndefined();
  });
});

test("nearby sensitive or hidden text never enters the attachment", async () => {
  await page((doc, select) => {
    for (const attributes of [
      "data-sensitive",
      "hidden",
      'aria-hidden="true"',
      'style="display:none"',
    ]) {
      doc.body.innerHTML = `<p id="p">safe quote<span ${attributes}>NEVER_ATTACH</span>ending</p>`;
      select("#p", 0, 4);
      const out = selectionLocation(doc, excluded)!;
      expect(out.selector).toBe("#p");
      expect(out.before).toBeUndefined();
      expect(out.after).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("NEVER_ATTACH");
    }
  });
});

test("broad page selections do not collect the rest of the document as surrounding text", async () => {
  await page((doc) => {
    doc.body.innerHTML = "<p>first</p><p>second</p>";
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    doc.getSelection()!.addRange(range);
    const out = selectionLocation(doc, excluded)!;
    expect(out.before).toBeUndefined();
    expect(out.after).toBeUndefined();
  });
});

test("location wire fields are bounded and malformed coordinates are discarded", () => {
  const ctx = cleanContext({
    selection: "quote",
    path: "/page?secret=no#fragment",
    location: {
      kind: "dom",
      selector: "s".repeat(999),
      before: "a".repeat(999),
      heading: "h".repeat(999),
      start: -1,
      end: 4,
      rect: { x: Infinity, y: 0, width: 1, height: 1 },
      unwanted: "DROP",
    },
  })!;
  expect(ctx.path).toBe("/page");
  expect(ctx.location?.selector).toHaveLength(300);
  expect(ctx.location?.before).toHaveLength(MAX_SELECTION_NEARBY);
  expect(ctx.location?.heading).toHaveLength(MAX_SELECTION_NEARBY);
  expect(ctx.location?.rect).toBeUndefined();
  expect(ctx.location?.start).toBeUndefined();
  expect(JSON.stringify(ctx)).not.toContain("DROP");
  expect(
    cleanContext({ selection: "quote", location: { kind: "arbitrary", selector: "x" } })?.location,
  ).toBeUndefined();
});

test("same text selected at a new location replaces the remembered anchor; chat focus keeps it", () => {
  let selector = "#first",
    selected = "quote",
    inChat = false;
  const doc = {
    activeElement: null,
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: !selected,
      anchorNode: null,
      focusNode: null,
      toString: () => selected,
    }),
    addEventListener() {},
    removeEventListener() {},
  } as SelectionDoc;
  const memory = createSelectionMemory({
    doc,
    inChat: () => inChat,
    where: () => ({ path: "/page" }),
    locate: () => ({ kind: "dom", selector }),
  });
  memory._events.onChange();
  selector = "#second";
  memory._events.onChange();
  expect(memory.get()?.location?.selector).toBe("#second");
  inChat = true;
  selected = "";
  memory._events.onDown({ target: {} });
  memory._events.onChange();
  expect(memory.get()?.location?.selector).toBe("#second");
});

test("the page-to-hub and listener contracts carry the full cleaned location", () => {
  const context = {
    selection: "quote",
    path: "/page",
    location: { kind: "dom" as const, selector: "#paragraph", start: 2, end: 7 },
  };
  const parsed = parsePageMessage(
    JSON.stringify({ type: "chat", id: "line123", text: "explain", context }),
  );
  expect(parsed).toMatchObject({ type: "chat", context });
  const line = chatLine(
    { id: "line", from: "owner", text: "explain", at: 1000, context },
    {},
    false,
  );
  expect(line?.context).toEqual(context);
});
