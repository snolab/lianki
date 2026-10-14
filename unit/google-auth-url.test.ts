import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { stripGrantedScopesHook, withoutGrantedScopes } from "@/lib/google-auth-url";

describe("withoutGrantedScopes", () => {
  test("drops include_granted_scopes from a Google URL, keeps everything else", () => {
    const out = new URL(
      withoutGrantedScopes(
        "https://accounts.google.com/o/oauth2/auth?client_id=x&scope=openid+email&include_granted_scopes=true&state=s",
      ),
    );
    expect(out.searchParams.has("include_granted_scopes")).toBe(false);
    expect(out.searchParams.get("scope")).toBe("openid email");
    expect(out.searchParams.get("state")).toBe("s");
  });

  test("leaves other hosts and junk untouched", () => {
    const gh = "https://github.com/login/oauth/authorize?include_granted_scopes=true";
    expect(withoutGrantedScopes(gh)).toBe(gh);
    expect(withoutGrantedScopes("not a url")).toBe("not a url");
  });
});

describe("stripGrantedScopesHook on a real better-auth instance", () => {
  // The provider hardcodes include_granted_scopes=true; for an account that once
  // granted Drive/YouTube to the same GCP project that made Google reject sign-in.
  const build = (withHook: boolean) =>
    betterAuth({
      secret: "x".repeat(32),
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      socialProviders: { google: { clientId: "cid", clientSecret: "secret" } },
      ...(withHook ? { hooks: { after: stripGrantedScopesHook } } : {}),
    });
  const signIn = async (withHook: boolean) => {
    const res = await build(withHook).handler(
      new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ provider: "google", callbackURL: "/list" }),
      }),
    );
    expect(res.status).toBe(200);
    return new URL(((await res.json()) as { url: string }).url);
  };

  test("without the hook the provider sends include_granted_scopes (the bug)", async () => {
    expect((await signIn(false)).searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("with the hook the sign-in URL no longer carries it", async () => {
    const url = await signIn(true);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/callback/google",
    );
  });
});
