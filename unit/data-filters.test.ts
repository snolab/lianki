import { describe, expect, it } from "bun:test";
import { dataFiltersToQuery, defaultFilters, parseDataFilters } from "../lib/data-filters";

const loggedIn = defaultFilters(true);
const guest = defaultFilters(false);

const q = (s: string) => new URLSearchParams(s);

describe("defaults", () => {
  it("starts on cloud when signed in, local otherwise", () => {
    expect(loggedIn.store).toBe("cloud");
    expect(guest.store).toBe("local");
  });
});

describe("parse", () => {
  it("returns defaults for an empty query", () => {
    expect(parseDataFilters(q(""), loggedIn)).toEqual(loggedIn);
    expect(parseDataFilters(null, loggedIn)).toEqual(loggedIn);
  });

  it("reads every filter", () => {
    expect(
      parseDataFilters(
        q("store=local&q=linkedin&state=2&due=1&sort=reps&order=desc&page=3"),
        loggedIn,
      ),
    ).toEqual({
      store: "local",
      q: "linkedin",
      state: 2,
      onlyDue: true,
      sort: "reps",
      order: "desc",
      page: 2, // one-based in the url, zero-based in state
    });
  });

  it("keeps a search term with spaces and unicode intact", () => {
    const params = q("?" + new URLSearchParams({ q: "日本語 vocab" }).toString());
    expect(parseDataFilters(params, loggedIn).q).toBe("日本語 vocab");
  });

  it("falls back rather than trusting a hand-edited address bar", () => {
    // Everything here came from a user pasting a url.
    const parsed = parseDataFilters(
      q("store=s3&state=9&sort=; DROP TABLE&order=sideways&page=-4"),
      loggedIn,
    );
    expect(parsed).toEqual(loggedIn);
  });

  it("treats state=0 as a real value, not as absent", () => {
    // "New" is state 0 — a falsy value that must survive the round trip.
    expect(parseDataFilters(q("state=0"), loggedIn).state).toBe(0);
  });

  it("reads due=0 as explicitly off", () => {
    const on = { ...loggedIn, onlyDue: true };
    expect(parseDataFilters(q("due=0"), on).onlyDue).toBe(false);
    expect(parseDataFilters(q(""), on).onlyDue).toBe(true);
  });

  it("clamps a fractional or out-of-range page", () => {
    expect(parseDataFilters(q("page=2.7"), loggedIn).page).toBe(1);
    expect(parseDataFilters(q("page=0"), loggedIn).page).toBe(0);
  });
});

describe("serialize", () => {
  it("writes nothing when nothing was changed", () => {
    expect(dataFiltersToQuery(loggedIn, loggedIn)).toBe("");
  });

  it("writes only what differs from the defaults", () => {
    const query = dataFiltersToQuery({ ...loggedIn, q: "linkedin", state: 2 }, loggedIn);
    expect(q(query).get("q")).toBe("linkedin");
    expect(q(query).get("state")).toBe("2");
    expect(q(query).has("sort")).toBe(false);
    expect(q(query).has("store")).toBe(false);
  });

  it("preserves ?lang, which drives the whole UI locale", () => {
    // Dropping it would flip the page back to English mid-session.
    const query = dataFiltersToQuery({ ...loggedIn, onlyDue: true }, loggedIn, q("lang=ja"));
    expect(q(query).get("lang")).toBe("ja");
    expect(q(query).get("due")).toBe("1");
  });

  it("does not carry stale filter params from the current url", () => {
    // Clearing a filter has to REMOVE it, not leave the old value behind.
    const query = dataFiltersToQuery(loggedIn, loggedIn, q("lang=ja&q=old&state=3"));
    expect(q(query).has("q")).toBe(false);
    expect(q(query).has("state")).toBe(false);
    expect(q(query).get("lang")).toBe("ja");
  });

  it("round-trips every filter", () => {
    const filters = {
      store: "local" as const,
      q: "日本語 vocab",
      state: 0,
      onlyDue: true,
      sort: "lapses",
      order: "desc" as const,
      page: 4,
    };
    expect(parseDataFilters(q(dataFiltersToQuery(filters, loggedIn)), loggedIn)).toEqual(filters);
  });

  it("round-trips for a guest, whose default store is local", () => {
    const filters = { ...guest, store: "cloud" as const, q: "x" };
    expect(parseDataFilters(q(dataFiltersToQuery(filters, guest)), guest)).toEqual(filters);
  });
});
