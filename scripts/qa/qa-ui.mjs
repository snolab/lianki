import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import { budget } from "./load-budget.mjs";
const BASE = process.env.QA_BASE || "http://localhost:3000";
const EMAIL = `qa+ui${Date.now()}@lianki.test`;
const PW = "qa-test-pass-1234";

const browser = await launchSilent(chromium);
const ctx = await newSilentContext(browser);
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
const badResponses = [];
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
const log = (s) => console.log(s);
let ok = true;
const check = (cond, msg) => {
  log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

// A virtual platform authenticator (Touch ID-like: internal transport, resident
// keys, user verification), so the passkey flows below run headless. It lives
// in the browser, not the page, so it survives navigations in this tab.
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const credentialCount = async () =>
  (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length;
const getSession = () =>
  page.evaluate(async () => {
    const r = await fetch("/api/auth/get-session");
    return r.ok ? await r.json() : null;
  });

// 0. Owner-only /dev/roadmap is a 404 for a guest. ctx.request shares the
// context's cookies but fires no page events, so the expected 404 does not
// land in badResponses / console errors.
{
  const r = await ctx.request.get(`${BASE}/dev/roadmap`, { maxRedirects: 0 });
  if (r.status() === 404) log("✓ /dev/roadmap is 404 for a guest");
  else {
    log(`✗ /dev/roadmap for a guest: HTTP ${r.status()} (want 404)`);
    ok = false;
  }
}

// 1. Sign-in page
await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
log(`✓ sign-in page loaded: ${await page.title()}`);
check(
  (await page.locator("#email").getAttribute("autocomplete")) === "username webauthn",
  "email field offers passkeys in autofill (autocomplete=username webauthn)",
);
check(
  await page.getByRole("button", { name: "Sign in with a passkey" }).isVisible(),
  "sign-in page shows the passkey button",
);

// 2. Email → Continue
await page.locator("#email").fill(EMAIL);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForSelector("#password", { timeout: budget(10000) });
log("✓ advanced to password step");

// 3. Password → Sign in (auto-signup on first use). With a platform
// authenticator present, the app then offers to add a passkey; turn it down
// here (the profile page adds one below) and land in the app.
await page.locator("#password").fill(PW);
await page.getByRole("button", { name: /sign in/i }).click();
{
  const suggestion = page.getByRole("heading", { name: "Sign in faster next time" });
  const offered = await suggestion
    .waitFor({ timeout: budget(20000) })
    .then(() => true)
    .catch(() => false);
  check(offered, "after an email sign-in, a passkey is offered");
  if (offered) {
    await Promise.all([
      page.waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(20000) }),
      page.getByRole("button", { name: "Not now" }).click(),
    ]);
    check(
      (await page.evaluate(() => localStorage.getItem("lianki:passkey-suggestion-dismissed"))) ===
        "1",
      "'Not now' is remembered on this device",
    );
  }
}

// 4. Authenticated?
const session = await page.evaluate(async () => {
  const r = await fetch("/api/auth/get-session");
  return r.ok ? await r.json() : null;
});
if (session?.user?.email === EMAIL)
  log(`✓ authenticated as ${session.user.email} (url=${page.url()})`);
else {
  log(`✗ not authenticated; url=${page.url()}`);
  ok = false;
}

// 5. Dashboard + roadmap render while logged in
await page.goto(`${BASE}/list`, { waitUntil: "networkidle" });
log(`✓ dashboard loaded: ${await page.title()}`);
await page.goto(`${BASE}/roadmap`, { waitUntil: "networkidle" });
log(`✓ roadmap loaded: ${await page.title()}`);

// 5b. …and still a 404 for a signed-in user who holds no permission grant (account_permission).
{
  const r = await ctx.request.get(`${BASE}/dev/roadmap`, { maxRedirects: 0 });
  if (r.status() === 404) log("✓ /dev/roadmap is 404 for a signed-in non-owner");
  else {
    log(`✗ /dev/roadmap for a non-owner: HTTP ${r.status()} (want 404)`);
    ok = false;
  }
}

// 5c0. Regressions from the iOS device QA (2026-10-29).
{
  // /list delete buttons once read "[object Object]" (IntlayerNode in an
  // attribute). Add a card so /list renders one.
  const added = await page.evaluate(async () => {
    const r = await fetch("/api/fsrs/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/qa-ui-delete", title: "QA delete" }),
    });
    return r.status;
  });
  await page.goto(`${BASE}/list`, { waitUntil: "networkidle" });
  const del = page.locator("li > button:last-child").first();
  const title = added === 200 ? await del.getAttribute("title").catch(() => null) : null;
  const label = added === 200 ? await del.getAttribute("aria-label").catch(() => null) : null;
  check(
    !!title && !!label && !/object Object/.test(title + label),
    `/list delete button has a real title and label ("${title}" / "${label}", add HTTP ${added})`,
  );

  // <html lang> follows the app locale (it read "en" under a French UI).
  await page.goto(`${BASE}/home?lang=fr`, { waitUntil: "networkidle" });
  const lang = await page.evaluate(() => document.documentElement.lang);
  check(lang === "fr", `<html lang> is the app locale on /home?lang=fr (${lang})`);
  // ?lang= sticks in a cookie: switch back so the English names below match.
  await page.goto(`${BASE}/home?lang=en`, { waitUntil: "networkidle" });

  // Explore cards on /home: a line of explanation each, and a drawing behind
  // it with no words in it and no layout shift (total ≈ 0).
  {
    const cls = await ctx.newPage();
    await cls.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await cls.setViewportSize({ width: 390, height: 844 });
    await cls.goto(`${BASE}/home`, { waitUntil: "networkidle" });
    const cards = cls.locator("[data-feature]");
    await cards.last().scrollIntoViewIfNeeded();
    await cls.waitForTimeout(800);
    const info = await cls.evaluate(() =>
      [...document.querySelectorAll("[data-feature]")].map((a) => {
        const art = a.querySelector("svg.lk-feature-art");
        const box = art?.getBoundingClientRect();
        return {
          text: a.textContent?.trim().length ?? 0,
          h: a.getBoundingClientRect().height,
          art: !!box && box.width > 0 && box.height > 0,
          hidden: art?.getAttribute("aria-hidden") === "true",
          wordless: !!art && !art.textContent?.trim() && !art.querySelector("text"),
          img: !!a.querySelector("img"),
        };
      }),
    );
    const shift = await cls.evaluate(() => window.__cls);
    check(
      info.length === 8 &&
        info.every((c) => c.text > 20 && c.h >= 160 && c.art && c.hidden && c.wordless && !c.img),
      `/home Explore: 8 cards, each with a line of text over a wordless drawing (${JSON.stringify(info[0])})`,
    );
    check(shift < 0.01, `/home Explore cards cause no layout shift (CLS ${shift.toFixed(4)})`);
    // The Word lists card opens the "Add a list" tree, in view, even when this
    // tab would otherwise reopen the list it last studied.
    await cls.goto(`${BASE}/words?list=all`, { waitUntil: "networkidle" });
    await cls.goto(`${BASE}/home`, { waitUntil: "networkidle" });
    await cls.locator('[data-feature="words"]').click();
    await cls.waitForURL(/\/words#add-list$/);
    const tree = cls.locator("[data-add-tree]");
    await tree.waitFor();
    await cls.waitForTimeout(300);
    const top = await tree.evaluate((el) => el.getBoundingClientRect().top);
    check(
      new URL(cls.url()).search === "" && top >= 0 && top < 844 / 2,
      `/home Word lists card lands on the Add a list tree (url ${cls.url()}, top ${Math.round(top)})`,
    );
    await cls.close();
  }

  // Phone width: the drawer is a modal dialog that Escape closes, and the
  // profile menu closes on a tap outside it (iOS never blurs its trigger).
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 414, height: 848 });
  await phone.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  // The header's Menu; the bottom island has one too (checked below).
  await phone.locator("header").getByRole("button", { name: "Menu", exact: true }).click();
  const drawer = phone.locator('[data-drawer][role="dialog"][aria-modal="true"]');
  const opened = await drawer
    .waitFor({ timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  const backdrop = await phone.getByRole("button", { name: "Close menu" }).count();
  await phone.keyboard.press("Escape");
  const closed = await drawer
    .waitFor({ state: "detached", timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  check(
    opened && backdrop === 1 && closed,
    `drawer: a modal dialog, backdrop "Close menu", Escape closes it (${opened}/${backdrop}/${closed})`,
  );

  // The bottom island (docs/bottom-nav.md): its Menu opens the same drawer,
  // and its Search opens the palette, which Escape closes.
  const island = phone.locator("[data-nav-island]");
  await island.getByRole("button", { name: /^Menu/ }).click();
  const viaIsland = await drawer
    .waitFor({ timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  await phone.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached", timeout: budget(5000) }).catch(() => {});
  await island.getByRole("button", { name: /^Search/ }).click();
  const palette = phone.getByRole("dialog", { name: "Search" });
  const searchOpen = await palette
    .waitFor({ timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  await phone.keyboard.press("Escape");
  const searchClosed = await palette
    .waitFor({ state: "detached", timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  check(
    viaIsland && searchOpen && searchClosed,
    `bottom island: Menu opens the drawer, Search the palette, Escape closes it (${viaIsland}/${searchOpen}/${searchClosed})`,
  );

  await phone.locator("[data-profile-menu]").click();
  const name = phone.locator("[data-debug-name]");
  await name.waitFor({ timeout: budget(5000) });
  await name.click();
  const stillOpen = await name.isVisible();
  // A plain tap on the page heading, outside the menu. Not locator.click():
  // that refuses because the open menu overlaps the point.
  const h1Box = await phone.locator("h1").first().boundingBox();
  await phone.mouse.click(h1Box.x + 4, h1Box.y + h1Box.height / 2);
  const shut = await name
    .waitFor({ state: "detached", timeout: budget(5000) })
    .then(() => true)
    .catch(() => false);
  check(
    stillOpen && shut,
    `profile menu: a tap on the name keeps it open, a tap outside closes it (${stillOpen}/${shut})`,
  );
  await phone.close();
}

// 5b1. The rail never runs off the screen (owner, 2026-11-09: "left side panel
// 太高了"). At each height every rail link is on screen, in "⋯", or in a list
// that scrolls to it; import, data and settings live in the account menu,
// which the rail's foot carries once the top bar has scrolled away.
for (const [w, h] of [
  [1512, 770],
  [1280, 600],
  [1024, 600],
]) {
  const rail = await ctx.newPage();
  await rail.setViewportSize({ width: w, height: h });
  await rail.goto(`${BASE}/home`, { waitUntil: "networkidle" });
  const reach = async () => {
    const more = rail.locator("[data-rail-more] > button");
    if (await more.count()) await more.click();
    const r = await rail.evaluate(() => {
      const list = document.querySelector("[data-app-nav] .lk-rail-scroll");
      const scrolls = list.scrollHeight > list.clientHeight + 1;
      const auto = getComputedStyle(list).overflowY === "auto";
      const inRail = [...list.querySelectorAll("a")].map((a) => ({
        href: a.getAttribute("href"),
        seen: a.getBoundingClientRect().bottom <= innerHeight + 0.5,
      }));
      const inMore = [...document.querySelectorAll("#lk-rail-more a")].map((a) => ({
        href: a.getAttribute("href"),
        seen: a.getBoundingClientRect().top >= 0 && a.getBoundingClientRect().bottom <= innerHeight,
      }));
      const foot = document.querySelector("[data-rail-foot]");
      const fb = foot.getBoundingClientRect();
      return {
        hrefs: [...inRail, ...inMore].map((l) => l.href),
        lost: [
          ...inRail.filter((l) => !l.seen && !(scrolls && auto)),
          ...inMore.filter((l) => !l.seen),
        ].map((l) => l.href),
        footIn: fb.top >= 0 && fb.bottom <= innerHeight + 0.5,
        footShown: getComputedStyle(foot).visibility === "visible",
      };
    });
    if (await more.count()) await rail.keyboard.press("Escape");
    return r;
  };
  const top = await reach();
  const want = ["/home", "/words", "/review", "/lab/polyglot", "/membership"];
  check(
    top.lost.length === 0 &&
      want.every((x) => top.hrefs.includes(x)) &&
      !["/import", "/data", "/preferences"].some((x) => top.hrefs.includes(x)) &&
      top.footIn &&
      !top.footShown,
    `rail ${w}x${h}: every link on screen or in "⋯", none of import/data/settings, foot kept for the account menu (${JSON.stringify(top)})`,
  );
  await rail.mouse.wheel(0, 600);
  await rail
    .locator("[data-rail-foot] [data-rail-profile]")
    .waitFor({ state: "visible", timeout: budget(5000) })
    .catch(() => {});
  const down = await reach();
  await rail.locator("[data-rail-foot] [data-rail-profile]").click();
  const menu = await rail.evaluate(() =>
    [...document.querySelectorAll("[data-rail-foot] a")].map((a) => a.getAttribute("href")),
  );
  check(
    down.lost.length === 0 &&
      down.hrefs.length === top.hrefs.length &&
      down.footIn &&
      down.footShown &&
      ["/profile", "/import", "/data", "/preferences"].every((x) => menu.includes(x)),
    `rail ${w}x${h} scrolled: same links, the account menu at the foot has profile/import/data/settings (${JSON.stringify({ down, menu })})`,
  );
  await rail.close();
}

// 5b2. Name and picture: pen, edit, save; the nav changes without a reload.
{
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  const shown = page.locator("[data-profile-menu]");
  await page.getByTestId("edit-name").click();
  const input = page.locator("#profile-name");
  await input.fill("Not saved");
  await input.press("Escape");
  await page.getByTestId("edit-name").waitFor({ timeout: budget(5000) });
  check(!(await page.getByText("Not saved").count()), "profile: Esc cancels the name edit");
  await page.getByTestId("edit-name").click();
  await input.fill("  Renamed QA ");
  await input.press("Enter");
  await page
    .getByText("Renamed QA")
    .first()
    .waitFor({ timeout: budget(10000) });
  await page.waitForFunction(
    () => document.querySelector("[data-profile-menu]")?.textContent?.includes("Renamed QA"),
    undefined,
    { timeout: budget(10000) },
  );
  check(true, "profile: Enter saves the name, and the nav shows it");

  // A real picture, drawn in the page: the browser's own downscale runs on it.
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 600;
    const x = c.getContext("2d");
    x.fillStyle = "seagreen";
    x.fillRect(0, 0, 900, 600);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("avatar-file").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await page.getByTestId("remove-avatar").waitFor({ timeout: budget(15000) });
  const size = await page.getByTestId("profile-avatar").evaluate(async (i) => {
    await i.decode();
    return [i.naturalWidth, i.naturalHeight];
  });
  check(
    size[0] === 512 && size[1] === 512,
    `profile: picture cropped to a 512 px square (${size})`,
  );
  await shown.locator('img[src^="/api/avatar/"]').waitFor({ timeout: budget(10000) });
  check(true, "…and the nav shows it without a reload");

  await page.getByTestId("avatar-file").setInputFiles({
    name: "evil.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await page.getByText("can't be used as a photo").waitFor({ timeout: budget(5000) });
  check(true, "profile: an SVG renamed .png is refused");

  await page.getByTestId("remove-avatar").click();
  await page.getByTestId("remove-avatar").waitFor({ state: "detached", timeout: budget(10000) });
  check(true, "profile: the picture can be removed");
}

// 5c. Passkeys: add one on the profile page, rename it, sign out, sign back in
// with it, then delete it.
{
  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await page.getByText("No passkeys yet.").waitFor({ timeout: budget(10000) });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const list = page.getByTestId("passkey-list");
  await list.waitFor({ timeout: budget(20000) });
  check((await list.locator("li").count()) === 1, "profile: a passkey was added and is listed");
  check(/Chrome/.test(await list.locator("li").first().innerText()), "…named after the browser");
  check((await credentialCount()) === 1, "…and the authenticator holds one resident credential");

  await list.getByRole("button", { name: "Rename" }).click();
  await list.getByLabel("Passkey name").fill("QA key");
  await list.getByRole("button", { name: "Save" }).click();
  await list.getByText("QA key").waitFor({ timeout: budget(10000) });
  check(true, "profile: passkey renamed");

  const out = await page.evaluate(async () => {
    const r = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  check(out === 200 && !(await getSession())?.user, "signed out");

  // Signed out, registration is refused outright.
  const reg = await ctx.request.get(`${BASE}/api/auth/passkey/generate-register-options`);
  check(reg.status() === 401, `register options need a session (HTTP ${reg.status()})`);

  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  // The autofill request may already have signed us in; otherwise use the button.
  if (/\/sign-in/.test(page.url()))
    await page
      .getByRole("button", { name: "Sign in with a passkey" })
      .click()
      .catch(() => {});
  await page
    .waitForURL((u) => /\/home|\/list/.test(u.toString()), { timeout: budget(20000) })
    .catch(() => {});
  const back = await getSession();
  check(back?.user?.email === EMAIL, `signed back in with the passkey (url=${page.url()})`);

  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
  await list.waitFor({ timeout: budget(10000) });
  await list.getByRole("button", { name: "Delete" }).click();
  await list.getByRole("button", { name: "Delete" }).click(); // confirm
  await page.getByText("No passkeys yet.").waitFor({ timeout: budget(10000) });
  check(true, "profile: passkey deleted");
}

// Page titles: the test box, adding and removing a pattern, restoring a default
// (docs/title-clean.md). Signed in again above, so the change syncs as well.
{
  await page.goto(`${BASE}/preferences`, { waitUntil: "networkidle" });
  const box = page.getByTestId("title-rules");
  await box.waitFor({ timeout: budget(10000) });
  const after = box.getByTestId("title-rules-after");
  check(
    (await after.innerText()) === "怎么能让书里的信息成为自己的知识呢？ - 知乎",
    "titles: the test box cleans the Zhihu sample",
  );
  await box.getByTestId("title-rules-try").fill("(2024) 年度总结 - 知乎");
  check(
    (await after.innerText()) === "(2024) 年度总结 - 知乎",
    "titles: a year in brackets is kept",
  );
  await box.getByTestId("title-rules-try").fill("[QA] hello");
  await box.getByTestId("title-rules-pattern").fill("[QA]");
  await box.getByRole("button", { name: "Add pattern" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="title-rules-after"]')?.textContent === "hello",
    null,
    { timeout: budget(5000) },
  );
  check(true, "titles: a pattern of your own applies at once");
  // A pref PATCH goes out 1 s after the last change.
  const patch = await page
    .waitForResponse((r) => r.url().includes("/api/prefs") && r.request().method() === "PATCH", {
      timeout: budget(8000),
    })
    .catch(() => null);
  check(patch?.ok() === true, "titles: the change syncs to the account");
  const prefs = await page.evaluate(async () => (await fetch("/api/preferences")).json());
  check(
    prefs.titleRules?.add?.[0]?.pattern === "[QA]",
    "titles: /api/preferences mirrors it for the userscript",
  );

  await box.getByTestId("title-rules-pattern").fill("*");
  await box.getByRole("button", { name: "Add pattern" }).click();
  check(
    (await box.locator("form").innerText()).includes("can't be used"),
    "titles: a pattern it cannot use is refused with a reason",
  );

  const restore = box.getByTestId("title-rules-restore");
  check(await restore.isDisabled(), "titles: nothing to restore yet");
  const rowsBefore = await box.locator("ul").last().locator("li").count();
  await box.locator("ul").last().getByRole("button", { name: "Remove" }).first().click();
  check(
    (await box.locator("ul").last().locator("li").count()) === rowsBefore - 1,
    "titles: a built-in pattern can be removed",
  );
  await restore.click();
  check(
    (await box.locator("ul").last().locator("li").count()) === rowsBefore,
    "titles: restore defaults brings it back",
  );
  await box.locator("ul").first().getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="title-rules-after"]')?.textContent === "[QA] hello",
    null,
    { timeout: budget(5000) },
  );
  check(true, "titles: your own pattern can be removed");
}

// Sign-in errors are the page's own words, never the server's text
// (lib/sign-in-errors.ts): a wrong password for the account made above is
// tried as a sign-up, which the server refuses ("User already exists"); the
// page shows its translated line instead. A fresh context, so this page's
// expected 4xx stay out of the checks below.
{
  const ctx2 = await newSilentContext(browser);
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
  await p2.locator("#email").fill(EMAIL);
  await p2.getByRole("button", { name: "Continue" }).click();
  await p2.waitForSelector("#password", { timeout: budget(10000) });
  await p2.locator("#password").fill(`${PW}-wrong`);
  await p2.getByRole("button", { name: /sign in/i }).click();
  // p: Next.js keeps its own role=alert route announcer on every page.
  const alert = p2.locator("p[role=alert]");
  const shown = await alert
    .waitFor({ timeout: budget(15000) })
    .then(() => alert.innerText())
    .catch(() => "");
  check(
    shown === "Couldn't create the account. Check the email and password.",
    `sign-in error is a known, translated line, not server text (got "${shown}")`,
  );
  await ctx2.close();
}

// 6. Console errors (ignore benign RSC prefetch aborts / 404 favicon / the
// passkey client logging the autofill request it abandons when the explicit
// passkey button starts its own / the
// Turnstile widget complaining about a missing sitekey — it gates only the
// magic-link button, not the password path this QA uses, and is undefined in
// any env without NEXT_PUBLIC_TURNSTILE_SITE_KEY configured, e.g. CI).
if (badResponses.length)
  log(`  4xx/5xx responses observed:\n    - ${badResponses.join("\n    - ")}`);
const real = errs.filter(
  (e) =>
    !/ERR_ABORTED|_rsc=|favicon|Failed to load resource.*40[01]|Cloudflare Turnstile.*sitekey|\[Better Auth\] Error verifying passkey/.test(
      e,
    ),
);
if (real.length) {
  log(`✗ console errors:\n  - ${real.slice(0, 8).join("\n  - ")}`);
  ok = false;
} else log("✓ no significant console errors (benign pre-auth 401/400 probes only)");

await browser.close();
log(`\n=== UI flow ${ok ? "PASSED" : "FAILED"} ===`);
process.exit(ok ? 0 : 1);
