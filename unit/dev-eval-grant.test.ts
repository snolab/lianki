import { describe, expect, it } from "bun:test";
import {
  DENIED,
  ENDED,
  GRANT_INVALID,
  chatClose,
  chatStep,
  evalStep,
  grantFileBody,
  readGrantFile,
  serveClose,
} from "@/scripts/dev/eval-grant";
import { PAGES_GONE } from "@/lib/dev-eval";

describe("eval.ts grant files", () => {
  it("a saved token is used until its expiry, not after", () => {
    const body = grantFileBody("t1", 10_000);
    expect(readGrantFile(body, 9_999)).toBe("t1");
    expect(readGrantFile(body, 10_000)).toBeUndefined();
  });

  it("a missing, malformed or empty file is no token; one without `until` is left to the hub", () => {
    expect(readGrantFile(undefined, 0)).toBeUndefined();
    expect(readGrantFile("{", 0)).toBeUndefined();
    expect(readGrantFile('{"token":""}', 0)).toBeUndefined();
    expect(readGrantFile('{"token":"old"}', 0)).toBe("old");
  });
});

describe("eval.ts: serve and one-shot evals try the token first", () => {
  it("a valid token resumes: never a pairing, whatever else is true", () => {
    expect(evalStep({ token: "t" })).toEqual({ kind: "resume", token: "t" });
    expect(evalStep({ token: "t", paired: true, noPair: true })).toMatchObject({ kind: "resume" });
  });

  it("only a missing or refused token pairs — once per process", () => {
    expect(evalStep({})).toEqual({ kind: "pair" });
    expect(evalStep({ token: "t", rejected: true })).toEqual({ kind: "pair" });
    expect(evalStep({ paired: true }).kind).toBe("fail");
    expect(evalStep({ token: "t", rejected: true, paired: true }).kind).toBe("fail");
  });

  it("--no-pair fails instead of prompting", () => {
    expect(evalStep({ noPair: true })).toMatchObject({ kind: "fail" });
    expect(String((evalStep({ noPair: true }) as { error: string }).error)).toContain("--no-pair");
    expect(evalStep({ token: "t", rejected: true, noPair: true }).kind).toBe("fail");
  });

  it("serve keeps running when its socket drops (pages gone, network) and ends on End or Deny", () => {
    expect(serveClose(PAGES_GONE, true)).toBe("lazy");
    expect(serveClose(1006, true)).toBe("lazy");
    expect(serveClose(ENDED, true)).toBe("end");
    expect(serveClose(DENIED, true)).toBe("end");
    // A friend's preview has no token to come back with.
    expect(serveClose(PAGES_GONE, false)).toBe("end");
  });
});

/**
 * The chat listener as eval.ts drives it: connect → (socket closes with
 * `code`) → connect again. Counts the pairings a run of closes causes.
 */
function listener(start: { token?: string }) {
  let token = start.token;
  let asked = false;
  let pairings = 0;
  let state: "open" | "gave-up" | "exited" = "open";
  const connect = () => {
    const step = chatStep({ token, paired: asked });
    if (step === "give-up") return void (state = "gave-up");
    if (step === "pair") {
      asked = true;
      pairings++;
    }
    state = "open";
  };
  connect();
  return {
    /** The open socket closed with `code`; `approved` = the owner allowed a pairing first. */
    close(code: number, approved = false) {
      if (state !== "open") return;
      if (approved) token = "granted";
      const what = chatClose(code);
      if (what === "refused") {
        token = undefined;
        return connect();
      }
      if (what === "ended" || what === "denied") return void (state = "exited");
      connect();
    },
    get pairings() {
      return pairings;
    },
    get state() {
      return state;
    },
  };
}

describe("eval.ts chat: no pairing loops", () => {
  it("with a grant, drops resume and never pair", () => {
    const l = listener({ token: "t" });
    for (const code of [1006, 1001, 1011, 4408, 1006]) l.close(code);
    expect(l.pairings).toBe(0);
    expect(l.state).toBe("open");
  });

  it("a refused grant pairs once; refused again, it gives up", () => {
    const l = listener({ token: "t" });
    l.close(GRANT_INVALID);
    expect(l.pairings).toBe(1);
    l.close(GRANT_INVALID);
    expect(l.pairings).toBe(1);
    expect(l.state).toBe("gave-up");
  });

  it("an unanswered, busy or page-less pairing is not asked again", () => {
    for (const code of [4408, 4429, 4404, 1006]) {
      const l = listener({});
      expect(l.pairings).toBe(1);
      l.close(code);
      l.close(code);
      expect(l.pairings).toBe(1);
      expect(l.state).toBe("gave-up");
    }
  });

  it("an approved pairing then drops resume with the saved grant", () => {
    const l = listener({});
    l.close(1006, true);
    l.close(1006);
    expect(l.pairings).toBe(1);
    expect(l.state).toBe("open");
    // The grant later refused: this run already asked once, so it stops.
    l.close(GRANT_INVALID);
    expect(l.pairings).toBe(1);
    expect(l.state).toBe("gave-up");
  });

  it("End or Deny exits", () => {
    expect(chatClose(ENDED)).toBe("ended");
    expect(chatClose(DENIED)).toBe("denied");
    const l = listener({ token: "t" });
    l.close(ENDED);
    expect(l.state).toBe("exited");
  });
});
