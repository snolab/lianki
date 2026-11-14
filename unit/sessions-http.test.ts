import { expect, test } from "bun:test";
import { sessionsHttp } from "@/lib/sessions-http";
const req = (body: unknown) =>
  new Request("https://sessions/internal/rpc", { method: "POST", body: JSON.stringify(body) });
test("private transport validates methods/arguments and carries the request abort signal", async () => {
  let called = 0;
  const call = async (method: string, args: unknown[], signal: AbortSignal) => {
    called++;
    expect(signal).toBeInstanceOf(AbortSignal);
    return { method, args };
  };
  expect((await sessionsHttp(new Request("https://sessions/other"), call)).status).toBe(404);
  for (const b of [
    null,
    {},
    { method: "constructor", args: [] },
    { method: "live", args: null },
    { method: "live", args: [1, 2, 3] },
  ])
    expect((await sessionsHttp(req(b), call)).status).toBe(400);
  expect(
    (
      await sessionsHttp(
        new Request("https://sessions/internal/rpc", { method: "POST", body: "not json" }),
        call,
      )
    ).status,
  ).toBe(400);
  const response = await sessionsHttp(req({ method: "live", args: ["fixture", "tag"] }), call);
  expect(await response.json()).toEqual({ value: { method: "live", args: ["fixture", "tag"] } });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(called).toBe(1);
  expect(
    await (await sessionsHttp(req({ method: "flag", args: [] }), async () => undefined)).json(),
  ).toEqual({ value: null });
  const c = new AbortController();
  c.abort(Error("cancelled"));
  await expect(
    sessionsHttp(new Request(req({ method: "live", args: [] }), { signal: c.signal }), call),
  ).rejects.toThrow("cancelled");
});
