import { describe, expect, spyOn, test } from "bun:test";
import { DEV_BRIDGE_HEADER } from "../lib/dev-bridge";
import {
  RECORDINGS_UPSTREAM,
  forwardRecordings,
  recordingsBridgeSecret,
} from "../lib/recordings-bridge";

const SECRET = "s".repeat(48);

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("recordingsBridgeSecret", () => {
  test("only on the preview, with a long enough secret", () => {
    expect(
      recordingsBridgeSecret({
        LIANKI_DEV_WHOLE_PAGE: "1",
        LIANKI_DEV_BRIDGE_SECRET: SECRET,
      } as never),
    ).toBe(SECRET);
    expect(recordingsBridgeSecret({ LIANKI_DEV_BRIDGE_SECRET: SECRET } as never)).toBeNull();
    expect(recordingsBridgeSecret({ LIANKI_DEV_WHOLE_PAGE: "1" } as never)).toBeNull();
    expect(
      recordingsBridgeSecret({
        LIANKI_DEV_WHOLE_PAGE: "1",
        LIANKI_DEV_BRIDGE_SECRET: "short",
      } as never),
    ).toBeNull();
  });
  test("defaults to process.env (unset in the unit run)", () => {
    expect(recordingsBridgeSecret()).toBeNull();
  });
});

describe("forwardRecordings", () => {
  test("GET: query kept, only the bridge header sent, body streamed back", async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "content-disposition": 'inline; filename="x.wav"',
            "set-cookie": "a=b",
          },
        }),
    );
    const req = new Request("http://127.0.0.1:3101/api/my/recordings?clip=abc&x=1", {
      headers: { cookie: "session=local", authorization: "Bearer lk_x", host: "127.0.0.1" },
    });
    const res = await forwardRecordings(req, SECRET, f);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${RECORDINGS_UPSTREAM}?clip=abc&x=1`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toEqual({ [DEV_BRIDGE_HEADER]: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="x.wav"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("no query: the bare upstream URL", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ days: [] }));
    await forwardRecordings(new Request("http://127.0.0.1:3101/api/my/recordings"), SECRET, f);
    expect(calls[0].url).toBe(RECORDINGS_UPSTREAM);
  });

  test("POST: same body and content type; upstream status kept", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ error: "too-large" }, { status: 413 }));
    const req = new Request("http://127.0.0.1:3101/api/my/recordings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id":"x"}',
    });
    const res = await forwardRecordings(req, SECRET, f);
    expect(calls[0].init.method).toBe("POST");
    expect(new TextDecoder().decode(calls[0].init.body as ArrayBuffer)).toBe('{"id":"x"}');
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too-large" });
  });

  test("DELETE: method and query passed on", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ ok: true, deleted: 3 }));
    const req = new Request("http://127.0.0.1:3101/api/my/recordings?day=2026-11-14", {
      method: "DELETE",
    });
    const res = await forwardRecordings(req, SECRET, f);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(`${RECORDINGS_UPSTREAM}?day=2026-11-14`);
    expect(await res.json()).toEqual({ ok: true, deleted: 3 });
  });

  test("unreachable: 502, and neither the answer nor the log names the secret", async () => {
    const logged: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
    const { f } = fakeFetch(() => {
      throw new Error(`fetch failed with ${SECRET}`);
    });
    const res = await forwardRecordings(
      new Request("http://127.0.0.1:3101/api/my/recordings"),
      SECRET,
      f,
    );
    spy.mockRestore();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("bridge-unreachable");
    expect(text).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged).toHaveLength(1);
  });
});
