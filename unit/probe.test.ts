import { describe, expect, it } from "bun:test";
import { classifyProbeError, probeReachability } from "@/lib/probe";

const err = (code: string, message = "fetch failed") =>
  Object.assign(new Error(message), { cause: { code } });

describe("classifyProbeError", () => {
  it("calls a name that does not resolve dead", () => {
    // A property of the site, not of who is asking: nobody can reach it.
    expect(classifyProbeError(err("ENOTFOUND"))).toEqual({ reachable: false, reason: "dns" });
    expect(classifyProbeError(err("EAI_AGAIN"))).toEqual({ reachable: false, reason: "dns" });
  });

  it("calls a broken TLS handshake dead", () => {
    // The retired site that left 75 cards stuck resolves fine — 207.148.96.127 —
    // and then fails the handshake with `tlsv1 alert internal error`. A DNS-only
    // rule would have missed exactly the case this feature exists for.
    // Every runtime words it differently, so all three shapes are pinned: a
    // narrow match falls through to "reachable" and the card stays stuck.
    expect(classifyProbeError(err("ERR_TLS_CERT_ALTNAME_INVALID")).reachable).toBe(false);
    expect(classifyProbeError(err("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR")).reason).toBe("tls");
    // Bun's shape: the code sits on the error itself, not on `cause`.
    expect(
      classifyProbeError(
        Object.assign(new Error("unknown certificate verification error"), {
          code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
        }),
      ),
    ).toEqual({ reachable: false, reason: "tls" });
  });

  it("does NOT call a refused connection or a timeout dead", () => {
    // These say as much about our egress as about the site. A host that drops
    // datacenter traffic answers a browser perfectly well, and calling it dead
    // would silently drop a card that works — worse than the stuck card this
    // guards against.
    expect(classifyProbeError(err("ECONNREFUSED")).reachable).toBe(true);
    expect(classifyProbeError(err("UND_ERR_CONNECT_TIMEOUT")).reachable).toBe(true);
    expect(classifyProbeError(new Error("The operation was aborted")).reachable).toBe(true);
  });

  it("defaults to reachable on anything it does not recognise", () => {
    expect(classifyProbeError(new Error("something new")).reachable).toBe(true);
    expect(classifyProbeError(undefined).reachable).toBe(true);
  });
});

describe("probeReachability", () => {
  const never = () => {
    throw new Error("must not be fetched");
  };

  it("reports any http answer as reachable, and passes the status through", async () => {
    for (const status of [200, 403, 404, 500]) {
      const r = await probeReachability("https://example.test/x", {
        fetchImpl: async () => new Response("", { status }),
      });
      expect(r).toMatchObject({ reachable: true, status, reason: "ok" });
    }
  });

  it("reports the url after redirects, for renaming a moved card", async () => {
    const r = await probeReachability("https://snomiao.com/", {
      fetchImpl: async () =>
        Object.defineProperty(new Response(""), "url", { value: "https://snomiao.com/ja" }),
    });
    expect(r.finalUrl).toBe("https://snomiao.com/ja");
  });

  it("uses GET, because too many hosts mishandle HEAD", async () => {
    let method = "";
    await probeReachability("https://example.test/x", {
      fetchImpl: async (_u, init) => {
        method = String(init?.method);
        return new Response("");
      },
    });
    expect(method).toBe("GET");
  });

  it("refuses to probe private and loopback hosts", async () => {
    // The endpoint fetches a url supplied by the client, so it is an SSRF
    // primitive. Authentication limits who can aim it; this limits where.
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://box.local/",
      "http://svc.internal/",
    ]) {
      const r = await probeReachability(url, { fetchImpl: never });
      expect(r).toEqual({ reachable: true, reason: "unjudgeable" });
    }
  });

  it("passes public addresses that merely look adjacent to private ones", async () => {
    // 172.32/12 is outside RFC1918; a sloppy `172.` prefix test would drop it.
    let fetched = false;
    await probeReachability("http://172.32.0.1/", {
      fetchImpl: async () => {
        fetched = true;
        return new Response("");
      },
    });
    expect(fetched).toBe(true);
  });

  it("declines to judge a non-http url or a malformed one", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", ""]) {
      expect(await probeReachability(url, { fetchImpl: never })).toEqual({
        reachable: true,
        reason: "unjudgeable",
      });
    }
  });

  it("classifies a transport failure rather than throwing", async () => {
    const r = await probeReachability("https://gone.test/", {
      fetchImpl: async () => {
        throw err("ENOTFOUND");
      },
    });
    expect(r).toEqual({ reachable: false, reason: "dns" });
  });

  it("gives up rather than hanging", async () => {
    const r = await probeReachability("https://slow.test/", {
      timeoutMs: 10,
      fetchImpl: (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new Error("The operation was aborted")),
          );
        }),
    });
    // A timeout is not evidence of death — the card still gets served.
    expect(r).toEqual({ reachable: true, reason: "timeout" });
  });
});
