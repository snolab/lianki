import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import {
  observeUserscriptInstall,
  publishUserscriptVersion,
  userscriptInstallState,
  USERSCRIPT_VERSION_ATTRIBUTE,
} from "../lib/userscript-install";

describe("live userscript version hints", () => {
  test("numeric versions distinguish missing, legacy, old, current and newer scripts", () => {
    expect(userscriptInstallState(null, "2.10.0")).toEqual({ status: "missing", version: null });
    expect(userscriptInstallState(null, "2.10.0", true)).toEqual({
      status: "outdated",
      version: null,
    });
    expect(userscriptInstallState("2.9.99", "2.10.0").status).toBe("outdated");
    expect(userscriptInstallState("2.10.0", "2.10.0").status).toBe("ready");
    expect(userscriptInstallState("2.10.1", "2.10.0").status).toBe("ready");
    expect(userscriptInstallState("3.0.0", "2.10.0").status).toBe("ready");
    expect(userscriptInstallState("1.99.99", "2.10.0").status).toBe("outdated");
    for (const invalid of ["", "<script>", "2.10", "2.10.0.1", "9999999.1.1", {}, 4]) {
      expect(userscriptInstallState(invalid, "2.10.0")).toEqual({
        status: "outdated",
        version: null,
      });
    }
    expect(userscriptInstallState("2.10.0", "invalid").status).toBe("outdated");
  });

  test("publishes only the version on trusted application origins and never clears a newer marker", async () => {
    const win = new Window();
    const el = win.document.documentElement as unknown as Element;
    try {
      for (const origin of [
        "https://example.com",
        "https://lianki.com.evil.test",
        "http://lianki.com",
        "https://other.lianki.com",
      ]) {
        publishUserscriptVersion(el, origin, "2.10.0")();
        expect(el.hasAttribute(USERSCRIPT_VERSION_ATTRIBUTE)).toBe(false);
      }
      publishUserscriptVersion(el, "https://lianki.com", "bad")();
      expect(el.hasAttribute(USERSCRIPT_VERSION_ATTRIBUTE)).toBe(false);
      for (const origin of [
        "https://lianki.com",
        "https://www.lianki.com",
        "https://preview.lianki.com",
      ]) {
        const stop = publishUserscriptVersion(el, origin, "2.10.0");
        expect(el.getAttribute(USERSCRIPT_VERSION_ATTRIBUTE)).toBe("2.10.0");
        stop();
        expect(el.hasAttribute(USERSCRIPT_VERSION_ATTRIBUTE)).toBe(false);
      }
      const stop = publishUserscriptVersion(el, "https://lianki.com", "2.10.0");
      el.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, "2.11.0");
      stop();
      expect(el.getAttribute(USERSCRIPT_VERSION_ATTRIBUTE)).toBe("2.11.0");
    } finally {
      await win.happyDOM.close();
    }
  });

  test("observes isolated-world DOM injection; stale storage cannot claim installation", async () => {
    const win = new Window({ url: "https://lianki.com/chat/sites" });
    const restore = stubGlobals({ MutationObserver: win.MutationObserver });
    const values: string[] = [];
    try {
      win.localStorage.setItem("lk:status", JSON.stringify({ version: "99.0.0" }));
      const stop = observeUserscriptInstall(
        win.document as unknown as Document,
        "2.10.0",
        (state) => values.push(state.status),
      );
      expect(values.at(-1)).toBe("missing");
      win.document.documentElement.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, "2.9.0");
      await win.happyDOM.whenAsyncComplete();
      expect(values.at(-1)).toBe("outdated");
      win.document.documentElement.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, "2.10.0");
      await win.happyDOM.whenAsyncComplete();
      expect(values.at(-1)).toBe("ready");
      win.document.documentElement.removeAttribute(USERSCRIPT_VERSION_ATTRIBUTE);
      (win as unknown as { LIANKI_USERSCRIPT_INSTALLED: boolean }).LIANKI_USERSCRIPT_INSTALLED =
        true;
      win.dispatchEvent(new win.Event("focus"));
      expect(values.at(-1)).toBe("outdated");
      win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
      win.document.dispatchEvent(new win.Event("visibilitychange"));
      expect(values.at(-1)).toBe("outdated");
      stop();
      const length = values.length;
      win.document.documentElement.setAttribute(USERSCRIPT_VERSION_ATTRIBUTE, "2.12.0");
      win.dispatchEvent(new win.Event("focus"));
      await win.happyDOM.whenAsyncComplete();
      expect(values).toHaveLength(length);
    } finally {
      restore();
      await win.happyDOM.close();
    }
  });
});
