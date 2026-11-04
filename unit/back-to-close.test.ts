import { describe, expect, it } from "bun:test";
import { BACK_KEY, type BackWinLike, dropOrphan, openBackToClose } from "@/lib/back-to-close";

/** A history stack whose back() lands later, as a browser's does. */
function fakeWin(start: unknown = { __NA: true, tree: "t" }, href = "https://lianki.com/en/words") {
  const entries: { state: unknown; href: string }[] = [{ state: start, href }];
  let at = 0;
  const pops: (() => void)[] = [];
  const queued: number[] = [];
  const win = {
    entries,
    get at() {
      return at;
    },
    history: {
      get state() {
        return entries[at].state;
      },
      get length() {
        return entries.length;
      },
      pushState(data: unknown, _?: string, url?: string) {
        const to = url ? new URL(url, entries[at].href).href : entries[at].href;
        entries.splice(at + 1, entries.length, { state: data, href: to });
        at++;
      },
      replaceState(data: unknown, _?: string, url?: string) {
        const to = url ? new URL(url, entries[at].href).href : entries[at].href;
        entries[at] = { state: data, href: to };
      },
      back() {
        queued.push(-1);
      },
    },
    location: {
      get href() {
        return entries[at].href;
      },
    },
    addEventListener: (_: "popstate", fn: () => void) => void pops.push(fn),
    removeEventListener: (_: "popstate", fn: () => void) => {
      const i = pops.indexOf(fn);
      if (i >= 0) pops.splice(i, 1);
    },
    /** Lands the queued history.back() calls, firing popstate for each. */
    settle() {
      while (queued.length) go(queued.shift()!);
    },
    /** The user's back button. */
    userBack() {
      go(-1);
    },
    /** The user's forward button. */
    userForward() {
      go(1);
    },
    /** A router.push to another URL. */
    navigate(to: string) {
      entries.splice(at + 1, entries.length, { state: { __NA: true, tree: to }, href: to });
      at++;
    },
    listeners: () => pops.length,
  };
  function go(d: number) {
    if (at + d < 0 || at + d >= entries.length) return;
    at += d;
    for (const fn of [...pops]) fn();
  }
  return win satisfies BackWinLike & Record<string, unknown>;
}

describe("openBackToClose", () => {
  it("pushes one entry on the same URL, keeping the router's state", () => {
    const w = fakeWin();
    openBackToClose(w, () => {});
    expect(w.entries.length).toBe(2);
    expect(w.history.state).toMatchObject({ __NA: true, tree: "t" });
    expect((w.history.state as Record<string, unknown>)[BACK_KEY]).toBeString();
    expect(w.location.href).toBe("https://lianki.com/en/words");
  });

  it("back closes the overlay and stays on the page", () => {
    const w = fakeWin();
    let closed = 0;
    const close = openBackToClose(w, () => closed++);
    w.userBack();
    expect(closed).toBe(1);
    expect(w.at).toBe(0);
    expect(w.listeners()).toBe(0);
    // The overlay's own close after onBack (React's effect cleanup) is a no-op.
    close();
    w.settle();
    expect(w.at).toBe(0);
  });

  it("closing by its own UI consumes the entry, once", () => {
    const w = fakeWin();
    let closed = 0;
    const close = openBackToClose(w, () => closed++);
    close();
    close();
    w.settle();
    expect(w.at).toBe(0);
    expect(closed).toBe(0);
    expect(w.listeners()).toBe(0);
  });

  it("does not go back after a router.push left the entry", () => {
    const w = fakeWin();
    const close = openBackToClose(w, () => {});
    w.navigate("https://lianki.com/en/lists");
    close();
    w.settle();
    expect(w.location.href).toBe("https://lianki.com/en/lists");
  });

  it("still consumes the entry when Next.js rewrote its state", () => {
    const w = fakeWin();
    const close = openBackToClose(w, () => {});
    w.history.replaceState({ __NA: true, tree: "t2" });
    close();
    w.settle();
    expect(w.at).toBe(0);
  });

  it("a reopen before the back lands waits for it", () => {
    const w = fakeWin();
    const first = openBackToClose(w, () => {});
    first();
    let closed = 0;
    openBackToClose(w, () => closed++);
    expect(w.at).toBe(1); // the back has not landed: nothing pushed yet
    w.settle();
    expect(closed).toBe(0);
    expect(w.at).toBe(1);
    expect(markOfTop(w)).toBeString();
    w.userBack();
    expect(closed).toBe(1);
    expect(w.at).toBe(0);
  });

  it("a reopen closed again before the back lands pushes nothing", () => {
    const w = fakeWin();
    openBackToClose(w, () => {})();
    openBackToClose(w, () => {})();
    w.settle();
    expect(w.at).toBe(0);
    expect(w.listeners()).toBe(0);
  });

  it("works on a page without router state", () => {
    const w = fakeWin(null);
    let closed = 0;
    openBackToClose(w, () => closed++);
    expect(markOfTop(w)).toBeString();
    w.userBack();
    expect(closed).toBe(1);
  });
});

describe("dropOrphan", () => {
  it("strips a marker left by a reload, keeping the rest", () => {
    const w = fakeWin({ __NA: true, tree: "t", [BACK_KEY]: "old" });
    dropOrphan(w);
    expect(w.history.state).toEqual({ __NA: true, tree: "t" });
  });

  it("keeps the marker of an overlay open now", () => {
    const w = fakeWin();
    openBackToClose(w, () => {});
    const before = w.history.state;
    dropOrphan(w);
    expect(w.history.state).toBe(before);
  });

  it("leaves unmarked and non-object states alone", () => {
    const a = fakeWin({ __NA: true });
    const b = fakeWin(null);
    dropOrphan(a);
    dropOrphan(b);
    expect(a.history.state).toEqual({ __NA: true });
    expect(b.history.state).toBeNull();
  });

  it("opening over an orphan strips it first", () => {
    const w = fakeWin({ __NA: true, [BACK_KEY]: "old" });
    openBackToClose(w, () => {});
    expect(w.entries[0].state).toEqual({ __NA: true });
  });
});

function markOfTop(w: { history: { state: unknown } }) {
  return (w.history.state as Record<string, unknown> | null)?.[BACK_KEY];
}

describe("an overlay pinned in the URL", () => {
  const BOOK = "https://lianki.com/read/abc";
  const pin = {
    url: (h: string) => `${new URL(h).pathname}?review=p3`,
    exit: (h: string) => new URL(h).pathname,
  };
  const mark = (w: { history: { state: unknown } }) =>
    (w.history.state as Record<string, unknown>)[BACK_KEY];

  it("pushes its address, leaving Next.js to copy its own keys back", () => {
    const w = fakeWin({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: "t", x: 1 }, BOOK);
    openBackToClose(w, () => {}, pin);
    expect(w.entries.length).toBe(2);
    expect(w.location.href).toBe(`${BOOK}?review=p3`);
    expect(w.history.state).toMatchObject({ x: 1 });
    expect(w.history.state).not.toHaveProperty("__NA");
    expect(mark(w)).toBeString();
  });

  it("back returns to the address without it and closes", () => {
    const w = fakeWin({ __NA: true }, BOOK);
    let closed = 0;
    openBackToClose(w, () => closed++, pin);
    w.userBack();
    expect(closed).toBe(1);
    expect(w.location.href).toBe(BOOK);
  });

  it("closing by its own UI goes back one entry", () => {
    const w = fakeWin({ __NA: true }, BOOK);
    const close = openBackToClose(w, () => {}, pin);
    close();
    w.settle();
    expect(w.at).toBe(0);
    expect(w.location.href).toBe(BOOK);
  });

  it("after a reload on its own entry, adopts it: no second entry, close goes back", () => {
    const w = fakeWin({ __NA: true }, BOOK);
    // The reload: the marker is left behind, nothing is open.
    w.history.pushState({ __NA: true, [BACK_KEY]: "old.2" }, "", `${BOOK}?review=p3`);
    dropOrphan(w);
    expect(mark(w)).toBeUndefined();
    let closed = 0;
    const close = openBackToClose(w, () => closed++, { ...pin, adopt: true });
    expect(w.entries.length).toBe(2);
    expect(mark(w)).toBeString();
    close();
    w.settle();
    expect(w.at).toBe(0);
    expect(w.location.href).toBe(BOOK);
    expect(closed).toBe(0);
  });

  it("adopted with the marker still on (no dropOrphan yet), it is its own too", () => {
    const w = fakeWin({ __NA: true }, BOOK);
    // A reload: the overlay that pushed this entry is gone, its marker stays.
    w.history.pushState({ __NA: true, [BACK_KEY]: "old.1" }, "", `${BOOK}?review=p3`);
    const close = openBackToClose(w, () => {}, { ...pin, adopt: true });
    close();
    w.settle();
    expect(w.at).toBe(0);
  });

  it("from a shared link (nothing behind it), close replaces the address", () => {
    const w = fakeWin({ __NA: true }, `${BOOK}?review=p3`);
    const close = openBackToClose(w, () => {}, { ...pin, adopt: true });
    expect(w.entries.length).toBe(1);
    close();
    w.settle();
    expect(w.entries.length).toBe(1);
    expect(w.location.href).toBe(BOOK);
    expect(mark(w)).toBeUndefined();
  });

  it("adopted, back off it closes", () => {
    const w = fakeWin({ __NA: true }, BOOK);
    w.history.pushState({ __NA: true }, "", `${BOOK}?review=p3`);
    let closed = 0;
    openBackToClose(w, () => closed++, { ...pin, adopt: true });
    w.userBack();
    expect(closed).toBe(1);
    expect(w.location.href).toBe(BOOK);
  });
});
