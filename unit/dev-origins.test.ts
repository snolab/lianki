import { expect, test } from "bun:test";
import { devOrigins } from "../lib/build/dev-origins.mjs";
test("Next dev permits only explicitly configured development hosts", () => {
  const env = {
    NODE_ENV: "development",
    LIANKI_DEV_WHOLE_PAGE: "1",
    BETTER_AUTH_BASE_URL: "https://device.example.ts.net:8443",
    LIANKI_DEV_PUBLIC_HOST: "preview.lianki.com",
  };
  expect(devOrigins(env)).toEqual(["device.example.ts.net", "preview.lianki.com"]);
  expect(devOrigins({ ...env, NODE_ENV: "production" })).toEqual([]);
  expect(devOrigins({ ...env, LIANKI_DEV_WHOLE_PAGE: "0" })).toEqual([]);
  expect(devOrigins({ ...env, LIANKI_DEV_WHOLE_PAGE: "0", LIANKI_DEVBOX: "1" })).toEqual([
    "device.example.ts.net",
  ]);
  expect(
    devOrigins({
      ...env,
      BETTER_AUTH_BASE_URL: "http://localhost:3100",
      LIANKI_DEV_PUBLIC_HOST: "",
    }),
  ).toEqual(["localhost"]);
  expect(
    devOrigins({ ...env, BETTER_AUTH_BASE_URL: undefined, LIANKI_DEV_PUBLIC_HOST: undefined }),
  ).toEqual([]);
  expect(
    devOrigins({
      ...env,
      BETTER_AUTH_BASE_URL: "http://127.0.0.1:3100",
      LIANKI_DEV_PUBLIC_HOST: "demo.trycloudflare.com",
    }),
  ).toEqual(["127.0.0.1", "demo.trycloudflare.com"]);
  for (const host of [
    "*.lianki.com",
    "preview.lianki.com.evil.example",
    "https://preview.lianki.com",
    "preview.lianki.com:443",
    "evil.example",
  ])
    expect(devOrigins({ ...env, LIANKI_DEV_PUBLIC_HOST: host })).toEqual(["device.example.ts.net"]);
  expect(devOrigins({ ...env, BETTER_AUTH_BASE_URL: "https://preview.lianki.com" })).toEqual([
    "preview.lianki.com",
  ]);
});
