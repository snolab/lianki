import { describe, expect, it } from "bun:test";
import {
  decodeEntities,
  sanitizeTree,
  treeClassStyle,
  treeSrc,
} from "@lianki/debug-chat/tree-source";

describe("treeSrc (lk:tree-src)", () => {
  it("allows https on a tailnet host, and localhost", () => {
    expect(treeSrc("https://my-mac.example.ts.net/lianki-preview/tree-frag.html")?.pathname).toBe(
      "/lianki-preview/tree-frag.html",
    );
    expect(treeSrc(" http://localhost:5180/tree.html ")?.host).toBe("localhost:5180");
    expect(treeSrc("http://127.0.0.1/t")).not.toBeNull();
    expect(treeSrc("https://[::1]/t")).not.toBeNull();
  });

  it("refuses anything else", () => {
    expect(treeSrc("http://my-mac.example.ts.net/t")).toBeNull(); // not https
    expect(treeSrc("https://evil.example/t")).toBeNull();
    expect(treeSrc("https://ts.net.evil.example/t")).toBeNull();
    expect(treeSrc("https://user:pw@my-mac.example.ts.net/t")).toBeNull();
    expect(treeSrc("javascript:alert(1)")).toBeNull();
    expect(treeSrc("data:text/html,<b>x</b>")).toBeNull();
    expect(treeSrc("not a url")).toBeNull();
    expect(treeSrc("")).toBeNull();
    expect(treeSrc(null)).toBeNull();
  });
});

describe("sanitizeTree", () => {
  it("keeps the allowed tags, with only their class", () => {
    expect(
      sanitizeTree(
        '<details open class="f" id="x"><summary class="d" onclick="alert(1)">Now</summary><ul><li class="ok w" style="color:red">done</li></ul></details>',
      ),
    ).toEqual([
      {
        tag: "details",
        cls: "f",
        children: [
          { tag: "summary", cls: "d", children: ["Now"] },
          { tag: "ul", children: [{ tag: "li", cls: "ok w", children: ["done"] }] },
        ],
      },
    ]);
    for (const tag of ["div", "span", "p", "b", "i", "code"])
      expect(sanitizeTree(`<${tag}>x</${tag}>`)).toEqual([{ tag, children: ["x"] }] as never);
  });

  it("drops scripts, styles and the like with their contents", () => {
    expect(
      sanitizeTree(
        'a<script>alert(1)</script>b<style>*{color:red}</style>c<SCRIPT src="x"></SCRIPT>d<svg><script>1</script></svg>e<iframe src="x">f</iframe>g',
      ),
    ).toEqual(["abcdeg"]);
    expect(sanitizeTree("<!-- <script>x</script> -->ok<!doctype html>")).toEqual(["ok"]);
  });

  it("drops event handlers, styles and links, keeping their text", () => {
    expect(
      sanitizeTree(
        '<span onmouseover="steal()" class="d">x</span><a href="javascript:alert(1)">link</a><a href="https://x">y</a><img src=x onerror=alert(1)>',
      ),
    ).toEqual([{ tag: "span", cls: "d", children: ["x"] }, "linky"]);
  });

  it("keeps class values to class-name characters", () => {
    expect(sanitizeTree(`<b class='w " onclick=x' >t</b>`)).toEqual([
      { tag: "b", cls: "w", children: ["t"] },
    ]);
    expect(sanitizeTree('<b class="a&quot;b ok">t</b>')).toEqual([
      { tag: "b", cls: "ok", children: ["t"] },
    ]);
    expect(sanitizeTree('<b class="">t</b>')).toEqual([{ tag: "b", children: ["t"] }]);
  });

  it("decodes text (rendered as text, never as HTML) and copes with broken markup", () => {
    expect(sanitizeTree("&lt;b&gt;not bold&lt;/b&gt; &amp; &#x1F333; &#26641;")).toEqual([
      "<b>not bold</b> & 🌳 树",
    ]);
    expect(sanitizeTree("<ul><li>a<li>b</ul>tail</div><")).toEqual([
      { tag: "ul", children: [{ tag: "li", children: ["a", { tag: "li", children: ["b"] }] }] },
      "tail<",
    ]);
    expect(sanitizeTree("<script>never closed")).toEqual([]);
    expect(decodeEntities("&bogus; &#0; &#xFFFFFFF;")).toBe("&bogus;  ");
  });
});

describe("treeClassStyle", () => {
  it("colours waiting, doing, done and the frontier block", () => {
    expect(treeClassStyle("w")).toEqual({ color: "oklch(0.62 0.17 35)", fontWeight: 700 });
    expect(treeClassStyle("d")).toEqual({ color: "oklch(0.62 0.14 250)" });
    expect(treeClassStyle("ok")).toEqual({ opacity: 0.6 });
    expect(treeClassStyle("f").marginBlockEnd).toBeDefined();
    expect(treeClassStyle(undefined)).toEqual({});
  });
});
