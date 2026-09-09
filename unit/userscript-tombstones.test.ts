import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";
import { compareHLC } from "@/app/fsrs-helpers";

/**
 * The delete/resurrect flip-flop.
 *
 * Deleting a card used to remove it from GM storage outright. The next
 * `prefetchDueCards` then saw no local copy, treated the server's card as new,
 * and wrote it back — so deleting the same card repeatedly left it exactly where
 * it was. Deletes are soft now: a tombstone with a fresh HLC stays behind and
 * outvotes the stale server copy.
 *
 * Runs against the BUILT public/lianki.user.js, since that is what users install.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

/** Lift `class GMCardStorage` out of the build by brace-matching. */
function extractStorageClass() {
  const start = BUILT.indexOf("class GMCardStorage {");
  if (start === -1) throw new Error("GMCardStorage not found in the built userscript");
  const open = BUILT.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < BUILT.length; i++) {
    if (BUILT[i] === "{") depth++;
    else if (BUILT[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new Error("could not brace-match GMCardStorage");
  return BUILT.slice(start, end);
}

const CLASS_SRC = extractStorageClass();

/** Instantiate the real class against an in-memory GM store. */
function makeStorage(clock = { now: 1_000_000 }) {
  const store = new Map<string, string>();
  const GM_getValue = (k: string, d = "") => store.get(k) ?? d;
  const GM_setValue = (k: string, v: string) => void store.set(k, String(v));
  const GM_deleteValue = (k: string) => void store.delete(k);

  const hashUrl = (url: string) => {
    let h = 5381;
    for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  const newHLC = (deviceId: string, last: { timestamp: number; counter: number } | null) => ({
    timestamp: clock.now,
    counter: last && last.timestamp === clock.now ? last.counter + 1 : 0,
    deviceId,
  });

  const Ctor = new Function(
    "GM_getValue",
    "GM_setValue",
    "GM_deleteValue",
    "hashUrl",
    "newHLC",
    "getDeviceId",
    "CARD_PREFIX",
    "INDEX_KEY",
    "MAX_CARDS",
    "Date",
    `${CLASS_SRC}; return GMCardStorage;`,
  )(
    GM_getValue,
    GM_setValue,
    GM_deleteValue,
    hashUrl,
    newHLC,
    () => "test-device",
    "lk:c:",
    "lk:card-index",
    2000,
    class extends Date {
      constructor(...args: unknown[]) {
        // @ts-expect-error - passthrough
        super(...(args.length ? args : [clock.now]));
      }
      static now() {
        return clock.now;
      }
    },
  );

  return { cs: new Ctor(), store, clock };
}

const card = (due: string) => ({ url: "", card: { due }, log: [] });
const URL_A = "https://linkedin.com/in/someone";
const past = new Date(1_000_000 - 60_000).toISOString();

describe("soft delete", () => {
  it("hides the card but keeps a tombstone", () => {
    const { cs } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "srv" }, false);
    expect(cs.getCard(URL_A)).not.toBeNull();

    cs.deleteCard(URL_A);

    expect(cs.getCard(URL_A)).toBeNull(); // gone for every normal reader
    expect(cs.getEntry(URL_A)?.deletedAt).toBeGreaterThan(0); // but still on record
    expect(cs.isDeleted(URL_A)).toBe(true);
  });

  it("outranks the stale server copy that used to resurrect it", () => {
    // This is the flip-flop, expressed as the comparison prefetchDueCards makes.
    const { cs } = makeStorage();
    const serverHlc = { timestamp: 500_000, counter: 0, deviceId: "server" };
    cs.setCard(URL_A, card(past), serverHlc, false);
    cs.deleteCard(URL_A);

    const local = cs.getEntry(URL_A);
    expect(compareHLC(serverHlc, local.hlc)).toBeLessThan(0); // server loses → no rewrite
  });

  it("still lets a genuinely newer server card win", () => {
    // A card edited AFTER the delete is a real resurrection, not a stale echo.
    const { cs } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 500_000, counter: 0, deviceId: "s" }, false);
    cs.deleteCard(URL_A);

    const newer = { timestamp: 2_000_000, counter: 0, deviceId: "server" };
    expect(compareHLC(newer, cs.getEntry(URL_A).hlc)).toBeGreaterThan(0);
  });

  it("keeps tombstones out of the due queue and the card list", () => {
    const { cs } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);
    cs.setCard(
      "https://keep.test/1",
      card(past),
      { timestamp: 1, counter: 0, deviceId: "s" },
      false,
    );
    cs.deleteCard(URL_A);

    expect(cs.getDueCards(10).map((c: { url: string }) => c.url)).toEqual(["https://keep.test/1"]);
    expect(cs.getAllCards().map((c: { url: string }) => c.url)).toEqual(["https://keep.test/1"]);
  });

  it("undeletes when the card is written again", () => {
    const { cs } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);
    cs.deleteCard(URL_A);
    cs.setCard(URL_A, card(past), { timestamp: 3_000_000, counter: 0, deviceId: "s" }, false);

    expect(cs.isDeleted(URL_A)).toBe(false);
    expect(cs.getDueCards(10)).toHaveLength(1);
  });

  it("deletes every live card once, and is idempotent", () => {
    const { cs } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);
    cs.setCard("https://b.test/1", card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);

    expect(cs.deleteAllCards()).toBe(2);
    expect(cs.deleteAllCards()).toBe(0); // tombstones are not re-deleted
    expect(cs.getDueCards(10)).toHaveLength(0);
  });
});

describe("capacity", () => {
  it("stores well past the old 2000-card cap without evicting", () => {
    // The cap used to delete the furthest-due card to make room — silently, and
    // possibly a dirty one carrying un-synced reviews. Only survivable while the
    // server held a full copy.
    const { cs } = makeStorage();
    for (let i = 0; i < 2100; i++) {
      cs.setCard(
        `https://example.test/${i}`,
        card(past),
        { timestamp: i, counter: 0, deviceId: "s" },
        false,
      );
    }
    expect(cs.getAllCards()).toHaveLength(2100);
    // The first card written is the one the old LDF eviction would have taken.
    expect(cs.getCard("https://example.test/0")).not.toBeNull();
  });

  it("reports a failed write instead of dropping someone else's card", () => {
    const { cs, store } = makeStorage();
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);
    const before = cs.getAllCards().length;

    // Simulate a quota rejection on the next card write.
    const realSet = store.set.bind(store);
    let failing = true;
    store.set = (k: string, v: string) => {
      if (failing && k.startsWith("lk:c:")) throw new Error("QuotaExceededError");
      return realSet(k, v);
    };

    expect(
      cs.setCard(
        "https://example.test/new",
        card(past),
        { timestamp: 2, counter: 0, deviceId: "s" },
        false,
      ),
    ).toBe(false);
    failing = false;
    // The existing card survived, and the index did not gain a phantom entry.
    expect(cs.getAllCards()).toHaveLength(before);
    expect(cs.getCard(URL_A)).not.toBeNull();
  });
});

describe("retention", () => {
  it("keeps a fresh tombstone and drops one past the window", () => {
    const clock = { now: 1_000_000 };
    const { cs } = makeStorage(clock);
    cs.setCard(URL_A, card(past), { timestamp: 1, counter: 0, deviceId: "s" }, false);
    cs.deleteCard(URL_A);

    expect(cs.purgeExpiredTombstones()).toBe(0); // still inside 90 days
    expect(cs.isDeleted(URL_A)).toBe(true);

    clock.now += 91 * 86400_000;
    expect(cs.purgeExpiredTombstones()).toBe(1);
    expect(cs.getEntry(URL_A)).toBeNull(); // now genuinely absent
  });
});

describe("redirect rename", () => {
  /** Lift the standalone helper out of the build, wired to a live storage. */
  function makeRename(cs: Record<string, (...a: unknown[]) => unknown>) {
    const start = BUILT.indexOf("function renameLocalCard(");
    if (start === -1) throw new Error("renameLocalCard not found in the built userscript");
    const open = BUILT.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < BUILT.length; i++) {
      if (BUILT[i] === "{") depth++;
      else if (BUILT[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    return new Function(
      "cardStorage",
      "compareHLC",
      "console",
      `${BUILT.slice(start, end)}; return renameLocalCard;`,
    )(cs, compareHLC, { log() {}, error() {} }) as (a: string, b: string) => void;
  }

  const OLD = "https://snomiao.com/";
  const NEW = "https://snomiao.com/ja";

  it("moves the card and tombstones the old url", () => {
    // The real bug: the server was renamed, GM storage was not, so the old url
    // stayed six months overdue and kept coming back for review.
    const { cs } = makeStorage();
    cs.setCard(OLD, card(past), { timestamp: 100, counter: 0, deviceId: "d" }, false);

    makeRename(cs)(OLD, NEW);

    expect(cs.getCard(OLD)).toBeNull();
    expect(cs.isDeleted(OLD)).toBe(true); // tombstoned, so it cannot resurrect
    expect(cs.getCard(NEW)).not.toBeNull();
    expect(cs.getDueCards(10).map((c: { url: string }) => c.url)).toEqual([NEW]);
  });

  it("keeps the newer side when both urls already hold a card", () => {
    // The duplicate pair: the new url was already being reviewed before the
    // redirect was noticed, so its history must not be clobbered.
    const { cs } = makeStorage();
    cs.setCard(OLD, card(past), { timestamp: 100, counter: 0, deviceId: "d" }, false);
    cs.setCard(NEW, card(past), { timestamp: 900, counter: 0, deviceId: "d" }, false);

    makeRename(cs)(OLD, NEW);

    expect(cs.getEntry(NEW).hlc.timestamp).toBe(900);
    expect(cs.isDeleted(OLD)).toBe(true);
    expect(cs.getDueCards(10)).toHaveLength(1); // no duplicate left behind
  });

  it("does nothing when there is no local card to move", () => {
    const { cs } = makeStorage();
    expect(() => makeRename(cs)(OLD, NEW)).not.toThrow();
    expect(cs.getCard(NEW)).toBeNull();
  });
});
