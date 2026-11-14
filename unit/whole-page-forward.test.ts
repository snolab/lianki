import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { addRequestMeta } from "next/dist/server/request-meta";
import { devForwardHeaders } from "../scripts/dev/whole-page-forward";
import { upstreamHeaders } from "../scripts/dev/preview-gate";
import { sameOriginJsonPost } from "../lib/security/same-origin";
import { trustedOrigins } from "../lib/trusted-origins";

const origins = [
  "https://preview.example",
  "https://device.example.ts.net:8443",
  "http://127.0.0.1:3100",
  "http://localhost:3100",
  "http://localhost",
  "http://192.168.1.2:3100",
  "https://192.168.1.2:3100",
];
const spoof = {
  forwarded: "host=evil.example;proto=https",
  "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "https",
  "x-forwarded-port": "443",
  "x-forwarded-for": "evil",
};

function headers(origin: string) {
  return {
    host: new URL(origin).host,
    origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    referer: `${origin}/dev/flags`,
    cookie: "session=local-fixture",
    ...spoof,
  };
}
function accepted(h: ReturnType<typeof devForwardHeaders>) {
  const request = new Request("http://127.0.0.1:3101/api/dev/flags", {
    method: "POST",
    headers: Object.fromEntries(
      Object.entries(h).filter(([, value]) => value !== undefined),
    ) as Record<string, string>,
  });
  return sameOriginJsonPost(request);
}

describe("trusted whole-page forwarding", () => {
  test("allowed auth routes retain Better Auth's configured origin, only after exact browser validation", () => {
    const keys = ["NODE_ENV", "LIANKI_DEV_WHOLE_PAGE", "BETTER_AUTH_BASE_URL"] as const;
    const env: Record<string, string | undefined> = process.env;
    const saved = keys.map((key) => env[key]);
    try {
      env.NODE_ENV = "development";
      process.env.LIANKI_DEV_WHOLE_PAGE = "1";
      for (const authOrigin of ["http://192.168.1.2:3100", "https://device.example.ts.net:8443"]) {
        process.env.BETTER_AUTH_BASE_URL = authOrigin;
        for (const origin of origins) {
          const valid = devForwardHeaders(headers(origin), origin, 3101, authOrigin);
          expect(valid.origin).toBe(authOrigin);
          expect(valid.host).toBe(new URL(authOrigin).host);
          expect(trustedOrigins()).toContain(String(valid.origin));
          for (const bad of [undefined, "null", "https://evil.example", `${origin}/`]) {
            const invalid = devForwardHeaders(
              { ...headers(origin), origin: bad },
              origin,
              3101,
              authOrigin,
            );
            expect(trustedOrigins()).not.toContain(invalid.origin!);
            expect(invalid.referer).toBeUndefined();
          }
          const cross = devForwardHeaders(
            { ...headers(origin), "sec-fetch-site": "cross-site" },
            origin,
            3101,
            authOrigin,
          );
          expect(trustedOrigins()).not.toContain(cross.origin!);
          expect(cross.referer).toBeUndefined();
        }
      }
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete env[key];
        else env[key] = saved[i];
      });
    }
  });
  test("public, TLS, loopback and authenticated LAN origins keep working without trusting client forwarding metadata", () => {
    for (const origin of origins) {
      const h = devForwardHeaders(headers(origin), origin, 3101);
      const target = origin.startsWith("http://192.") ? "http://127.0.0.1:3101" : origin;
      expect(h.host).toBe(new URL(target).host);
      expect(h.origin).toBe(target);
      expect(h.referer).toBe(`${target}/dev/flags`);
      expect(h["x-forwarded-host"]).toBe(h.host);
      expect(h["x-forwarded-proto"]).toBe(new URL(target).protocol.slice(0, -1));
      expect(h["x-forwarded-port"]).toBe(
        new URL(target).port || (target.startsWith("https:") ? "443" : "80"),
      );
      expect(h.forwarded).toBeUndefined();
      expect(h["x-forwarded-for"]).toBeUndefined();
      expect(h.cookie).toBe("session=local-fixture");
      expect(accepted(h)).toBe(true);
      expect(
        accepted(
          devForwardHeaders(
            { ...headers(origin), "sec-fetch-site": undefined, referer: undefined },
            origin,
            3101,
          ),
        ),
      ).toBe(true);
      const mixed = devForwardHeaders(
        {
          ...headers(origin),
          Forwarded: "host=attacker",
          "X-Forwarded-Host": "attacker",
          "X-Forwarded-Unknown": "attacker",
        },
        origin,
        3101,
      );
      expect(mixed["x-forwarded-host"]).toBe(h.host);
      expect(mixed["x-forwarded-unknown"]).toBeUndefined();
      expect(mixed.forwarded).toBeUndefined();
    }
  });

  test("missing, hostile and lookalike Origins cannot gain same-origin through forged forwarded headers", () => {
    for (const origin of origins) {
      for (const hostile of [
        undefined,
        "null",
        "https://evil.example",
        `${origin}.evil.example`,
        `${origin}/`,
        "http://127.0.0.1:3101",
      ]) {
        const input = {
          ...headers(origin),
          origin: hostile,
          "x-forwarded-host": new URL(origin).host,
          "x-forwarded-proto": new URL(origin).protocol.slice(0, -1),
        };
        expect(accepted(devForwardHeaders(input, origin, 3101))).toBe(false);
      }
      expect(
        accepted(
          devForwardHeaders({ ...headers(origin), "sec-fetch-site": "cross-site" }, origin, 3101),
        ),
      ).toBe(false);
      expect(() =>
        devForwardHeaders({ ...headers(origin), host: "evil.example" }, origin, 3101),
      ).toThrow("unexpected dev request host");
      expect(() => devForwardHeaders({ origin }, origin, 3101)).toThrow();
      expect(() => devForwardHeaders({ host: [new URL(origin).host] }, origin, 3101)).toThrow();
    }
  });

  test("local guard→Next adapter accepts same-origin JSON on both affected routes, even though request.url is loopback", async () => {
    const upstream = http.createServer((req, res) => {
      const next = new NodeNextRequest(req);
      addRequestMeta(next, "initURL", `http://127.0.0.1:3101${req.url}`);
      const adapted = NextRequestAdapter.fromNodeNextRequest(next, new AbortController().signal);
      res.writeHead(sameOriginJsonPost(adapted) ? 200 : 403, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          url: adapted.url,
          host: adapted.headers.get("host"),
          origin: adapted.headers.get("origin"),
          forwardedHost: adapted.headers.get("x-forwarded-host"),
        }),
      );
      req.resume();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const inner = (upstream.address() as AddressInfo).port;
    const origin = "https://preview.example";
    const guard = http.createServer((req, res) => {
      const sanitized = upstreamHeaders(req.headers, {
        publicHost: new URL(origin).host,
        origin: "http://192.168.1.2:3100",
        drop: [],
      });
      const up = http.request(
        {
          host: "127.0.0.1",
          port: inner,
          path: req.url,
          method: req.method,
          headers: devForwardHeaders(sanitized, origin, inner),
        },
        (reply) => {
          res.writeHead(reply.statusCode!);
          reply.pipe(res);
        },
      );
      up.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    await new Promise<void>((resolve) => guard.listen(0, "127.0.0.1", resolve));
    const port = (guard.address() as AddressInfo).port;
    try {
      for (const path of ["/api/token", "/api/dev/flags"]) {
        for (const requestOrigin of [origin, "https://evil.example", "null", undefined]) {
          const h = headers(origin) as Record<string, string>;
          if (requestOrigin) h.origin = requestOrigin;
          else delete h.origin;
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: h,
            body: "{}",
          });
          expect(response.status).toBe(requestOrigin === origin ? 200 : 403);
          const body = await response.json();
          // NextURL normalizes loopback IPs to localhost.
          expect(body.url).toBe(`http://localhost:3101${path}`);
          expect(body.host).toBe("preview.example");
          expect(body.forwardedHost).toBe("preview.example");
        }
      }
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => guard.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });
});
