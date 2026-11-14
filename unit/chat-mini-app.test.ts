import { expect, test } from "bun:test";
import {
  cleanAppRefs,
  isMiniAppSlug,
  miniAppApiOrigin,
  miniAppsIn,
  miniAppSlug,
} from "../packages/debug-chat/src/mini-app-links";
import {
  type MiniAppEmbedView,
  clampMiniAppHeight,
  miniAppEmbedView,
  miniAppKeyHeight,
} from "../packages/debug-chat/src/mini-app-panel";

test("mini app references accept only app slugs and trustworthy link destinations", () => {
  for (const slug of [null, "", "-a", "a--b", "A", "a-", "sdk", "x".repeat(41)])
    expect(isMiniAppSlug(slug)).toBe(false);
  expect(isMiniAppSlug("my-app2")).toBe(true);
  expect(cleanAppRefs(null)).toBeUndefined();
  expect(
    cleanAppRefs([{}, null, { type: "image", slug: "app" }, { type: "app", slug: "sdk" }]),
  ).toBeUndefined();
  expect(
    cleanAppRefs([
      "a",
      { type: "app", slug: "a" },
      { type: "app", slug: "a" },
      ...["b", "c", "d", "e"].map((slug) => ({ type: "app", slug })),
    ]),
  ).toEqual(["a", "b", "c", "d"].map((slug) => ({ type: "app", slug })));
  for (const href of [
    "/m/demo",
    "https://lianki.com/m/demo",
    "https://www.lianki.com/m/demo/",
    "https://preview.lianki.com/m/demo?q=1#x",
    "https://dev.lianki.com/m/demo",
  ])
    expect(miniAppSlug(href)).toBe("demo");
  expect(miniAppSlug("http://localhost:3000/m/demo", "http://localhost:3000")).toBe("demo");
  for (const href of [
    "https://evil.test/m/demo",
    "https://lianki.com.evil.test/m/demo",
    "https://lianki.com@evil.test/m/demo",
    "https://evil@lianki.com/m/demo",
    "http://lianki.com/m/demo",
    "//lianki.com/m/demo",
    "javascript:/m/demo",
    "/m/demo/extra",
    "/m/sdk",
    "/m/%64emo",
    "/m/de mo",
    "/m/\\demo",
    "m/demo",
    "https://[bad",
  ])
    expect(miniAppSlug(href)).toBeNull();
  expect(miniAppSlug("http://localhost:3000/m/demo", "http://localhost:4000")).toBeNull();
  expect(miniAppSlug("http://evil.test/m/demo", "http://evil.test")).toBeNull();
  expect(miniAppApiOrigin("broken")).toBe("https://lianki.com");
  expect(miniAppApiOrigin("http://user@localhost:3000")).toBe("https://lianki.com");
  expect(miniAppApiOrigin("ftp://localhost")).toBe("https://lianki.com");
  expect(miniAppApiOrigin("http://localhost:3000/path")).toBe("https://lianki.com");
  expect(miniAppApiOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  expect(miniAppApiOrigin()).toBe("https://lianki.com");
  expect(
    miniAppsIn("[demo](/m/demo). https://evil.test/m/forged /m/demo https://lianki.com/m/next", [
      { type: "app", slug: "explicit" },
    ]),
  ).toEqual(["explicit", "demo", "next"].map((slug) => ({ type: "app", slug })));
  expect(miniAppsIn("https://evil.test/?next=/m/forged")).toEqual([]);
});

test("panel sizing stays within viewport, including small screens and malformed values", () => {
  expect(clampMiniAppHeight(360, 100, 160)).toBe(100);
  expect(clampMiniAppHeight(20, 800, 160)).toBe(160);
  expect(clampMiniAppHeight(Infinity, 800, NaN)).toBe(0);
  expect(clampMiniAppHeight(200, NaN, 100)).toBe(0);
  const sizing = { height: 360, minHeight: 160, step: 24 };
  expect(miniAppKeyHeight("ArrowUp", 360, 800, sizing)).toBe(384);
  expect(miniAppKeyHeight("ArrowDown", 360, 800, sizing)).toBe(336);
  expect(miniAppKeyHeight("Home", 360, 800, sizing)).toBe(160);
  expect(miniAppKeyHeight("End", 360, 800, sizing)).toBe(800);
  expect(miniAppKeyHeight("a", 360, 800, sizing)).toBeNull();
  expect(miniAppKeyHeight("ArrowUp", 360, 800, { ...sizing, step: NaN })).toBe(360);
});

test("only forced opaque srcdoc views reach the host slot", () => {
  const view: MiniAppEmbedView = {
    slug: "demo",
    name: "Demo",
    icon: "A",
    version: "1.0.0",
    style: "none",
    permissions: [],
    grants: {},
    frame: { mode: "srcdoc", srcdoc: "<p>App</p>", sandbox: "allow-scripts allow-forms" },
  };
  expect(miniAppEmbedView(view, "demo")).toEqual(view);
  for (const raw of [
    null,
    false,
    {},
    { ...view, slug: "other" },
    { ...view, name: 3 },
    { ...view, icon: null },
    { ...view, version: 3 },
    { ...view, style: "fake" },
    { ...view, permissions: null },
    { ...view, permissions: [3] },
    { ...view, grants: null },
    { ...view, grants: [] },
    { ...view, grants: { cap: 3 } },
    { ...view, frame: null },
    { ...view, frame: { mode: "origin" } },
    { ...view, frame: { ...view.frame, srcdoc: 3 } },
    { ...view, frame: { ...view.frame, sandbox: "allow-scripts allow-same-origin" } },
  ])
    expect(miniAppEmbedView(raw, "demo")).toBeNull();
});
