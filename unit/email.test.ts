import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isEmailConfigured, RESEND_NOT_CONFIGURED, sendEmail } from "../lib/email";

const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
});

const configure = () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Lianki <noreply@lianki.com>";
};

const ok = (body: string, init: ResponseInit = {}) => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, reqInit: RequestInit) => {
    seen = { url, init: reqInit };
    return new Response(body, init);
  }) as never;
  return () => seen!;
};

describe("configuration", () => {
  it("needs both a key and a from address", () => {
    expect(isEmailConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "re_test_key";
    expect(isEmailConfigured()).toBe(false);
    process.env.EMAIL_FROM = "noreply@lianki.com";
    expect(isEmailConfigured()).toBe(true);
  });

  it("treats whitespace as unset", () => {
    process.env.RESEND_API_KEY = "  ";
    process.env.EMAIL_FROM = "noreply@lianki.com";
    expect(isEmailConfigured()).toBe(false);
  });

  it("refuses to pretend it sent something when unconfigured", () => {
    // Swallowing this would tell the user a magic link is on the way when none
    // was ever sent — the failure mode that hides itself.
    expect(sendEmail({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow(
      RESEND_NOT_CONFIGURED,
    );
  });
});

describe("send", () => {
  it("posts the message to Resend with the api key", async () => {
    configure();
    const seen = ok(JSON.stringify({ id: "msg_123" }));

    const res = await sendEmail({
      to: "user@example.com",
      subject: "Sign in to Lianki",
      text: "Sign in: https://lianki.com/x",
      html: "<a>Sign in</a>",
    });

    expect(res.id).toBe("msg_123");
    expect(seen().url).toBe("https://api.resend.com/emails");
    expect((seen().init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
    expect(JSON.parse(seen().init.body as string)).toEqual({
      from: "Lianki <noreply@lianki.com>",
      to: ["user@example.com"],
      subject: "Sign in to Lianki",
      text: "Sign in: https://lianki.com/x",
      html: "<a>Sign in</a>",
    });
  });

  it("omits html when there is none", async () => {
    configure();
    const seen = ok(JSON.stringify({ id: "x" }));
    await sendEmail({ to: "a@b.test", subject: "s", text: "t" });
    expect("html" in JSON.parse(seen().init.body as string)).toBe(false);
  });

  it("surfaces Resend's reason rather than a bare status", async () => {
    // "domain is not verified" is the difference between a fixable message and
    // a support ticket.
    configure();
    ok(
      JSON.stringify({
        name: "validation_error",
        message: "The lianki.com domain is not verified",
      }),
      {
        status: 403,
      },
    );
    expect(sendEmail({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow(
      /HTTP 403.*validation_error.*not verified/s,
    );
  });

  it("still throws when the error body is not json", async () => {
    configure();
    ok("<html>gateway timeout</html>", { status: 504 });
    expect(sendEmail({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow(/HTTP 504/);
  });

  it("accepts a 2xx whose body is not json", async () => {
    // Accepted is accepted; failing the login over a response shape would be
    // worse than not knowing the message id.
    configure();
    ok("", { status: 202 });
    await expect(sendEmail({ to: "a@b.test", subject: "s", text: "t" })).resolves.toEqual({
      id: "",
    });
  });
});
