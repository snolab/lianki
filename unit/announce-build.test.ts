import { describe, expect, it } from "bun:test";
import { FINGERPRINTS_PATH, announceBuild, publishInit } from "@/lib/announce-build";
import { FINGERPRINTS_HEADER } from "@/lib/smart-refresh";

const assets = (body: unknown, ok = true) => ({
  fetch: async (url: string) => {
    expect(url).toEndWith(FINGERPRINTS_PATH);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: ok ? 200 : 404,
    });
  },
});
const header = (init: RequestInit) =>
  (init.headers as Record<string, string> | undefined)?.[FINGERPRINTS_HEADER];

describe("publishInit", () => {
  it("sends the bare build id, its fingerprints in a header", async () => {
    const fp = { build: "b1", shell: "s", routes: { "/words": "h" } };
    const init = await publishInit("b1", assets(fp));
    expect(init.body).toBe("b1");
    expect(JSON.parse(decodeURIComponent(header(init)!))).toEqual(fp);
  });
  it("sends the build id alone without them", async () => {
    for (const a of [
      undefined,
      assets({}, false),
      assets({ build: "other" }),
      assets("not json"),
    ]) {
      const init = await publishInit("b1", a);
      expect(init.body).toBe("b1");
      expect(header(init)).toBeUndefined();
    }
  });
});

describe("announceBuild", () => {
  it("posts once per isolate, through the PUSH binding", async () => {
    const was = process.env.NEXT_PUBLIC_BUILD_ID;
    process.env.NEXT_PUBLIC_BUILD_ID = "b1";
    const posted: RequestInit[] = [];
    const waits: Promise<unknown>[] = [];
    const context = () => ({
      env: {
        PUSH: {
          fetch: async (_url: string, init?: RequestInit) => {
            posted.push(init!);
            throw new Error("push down"); // swallowed: the notice is best effort
          },
        },
        ASSETS: assets({ build: "b1", shell: "s", routes: {} }),
      },
      ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) },
    });
    try {
      announceBuild(context);
      announceBuild(context); // the same isolate: nothing more
      await Promise.all(waits);
      expect(posted.length).toBe(1);
      expect(posted[0].body).toBe("b1");
      expect(header(posted[0])).toBeDefined();
    } finally {
      process.env.NEXT_PUBLIC_BUILD_ID = was;
    }
  });
});
