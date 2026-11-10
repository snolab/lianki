import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ApiError, OfflineError, reasonOf, reasonText } from "@/lib/words/error-reason";

// /words never shows a server's code, an HTTP status or the browser's own
// error text: four plain reasons instead (words-status.content.ts).
describe("words error reasons", () => {
  it("maps failures to plain reasons", () => {
    expect(reasonOf(new OfflineError())).toBe("offline");
    expect(reasonOf(new TypeError("Failed to fetch"))).toBe("offline");
    expect(reasonOf(new ApiError(401, "login-required"))).toBe("signIn");
    expect(reasonOf(new ApiError(404, "not-found"))).toBe("notFound");
    expect(reasonOf(new ApiError(503, "unavailable"))).toBe("tryAgain");
    expect(reasonOf(new Error("Internal Server Error"))).toBe("tryAgain");
  });

  it("reads the reason's text from the dictionary", () => {
    const text = {
      reasonOffline: { value: "you're offline" },
      reasonSignIn: "please sign in again",
      reasonNotFound: "gone",
      reasonTryAgain: "try again",
    };
    expect(reasonText(text, "offline")).toBe("you're offline");
    expect(reasonText(text, "signIn")).toBe("please sign in again");
  });

  it("WordsClient shows no raw error text", () => {
    const src = readFileSync("app/(app)/words/WordsClient.tsx", "utf8");
    expect(src).not.toMatch(/set(Load|Sync)?Error\(\(e as Error\)\.message\)/);
    expect(src).not.toContain('error === "Login required"');
    expect(src).not.toContain("res.statusText");
  });
});
