// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_info
// @version     2.5.6
// @author      snomiao@gmail.com
// @description Lianki spaced repetition — inline review without page navigation
// @run-at      document-end
// @downloadURL https://www.lianki.com/lianki.user.js
// @updateURL   https://www.lianki.com/lianki.user.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     beta.lianki.com
// ==/UserScript==

if (window.self !== window.top) return;
globalThis.unload_Lianki?.();
globalThis.unload_Lianki = main();

function main() {
  // ── Origin ─────────────────────────────────────────────────────────────────
  // Auto-detected from @downloadURL so beta.lianki.com works too.
  // Normalize bare lianki.com → www.lianki.com: __Host- cookies bind to exact hostname.
  const ORIGIN = (() => {
    try {
      const u = new URL(GM_info?.script?.downloadURL || "");
      if (u.hostname === "lianki.com") u.hostname = "www.lianki.com";
      return u.origin;
    } catch {
      return "https://www.lianki.com";
    }
  })();

  // ── URL normalization ───────────────────────────────────────────────────────
  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      // youtu.be/ID → youtube.com/watch?v=ID
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1);
        u.hostname = "www.youtube.com";
        u.pathname = "/watch";
        u.searchParams.set("v", id);
      }
      // m.example.com → www.example.com
      if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
      // Strip tracking & session params
      for (const p of [
        "si",
        "pp",
        "feature",
        "ref",
        "source",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "igshid",
      ])
        u.searchParams.delete(p);
      u.searchParams.sort();
      return u.toString();
    } catch {
      return href;
    }
  }

  // Skip running on the Lianki app itself
  if (location.hostname === new URL(ORIGIN).hostname) return () => {};

  const ac = new AbortController();
  const { signal } = ac;

  // ── Constants ──────────────────────────────────────────────────────────────
  // Domains that hijack navigation to their native app on mobile
  const MOBILE_APP_DOMAINS = ["zhihu.com"];
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // ── State ──────────────────────────────────────────────────────────────────
  let state = { phase: "idle", noteId: null, options: null, error: null, message: null };
  let fab = null;
  let dialog = null;
  let prefetchedNextUrl = null; // populated while user reads current card

  // ── Auto-update ────────────────────────────────────────────────────────────
  const CURRENT_VERSION = GM_info?.script?.version ?? "0.0.0";
  let updatePrompted = false;

  function isNewerVersion(a, b) {
    const seg = (v) => v.split(".").map((n) => parseInt(n) || 0);
    const [aa, ab, ac2] = seg(a);
    const [ba, bb, bc] = seg(b);
    return aa !== ba ? aa > ba : ab !== bb ? ab > bb : ac2 > bc;
  }

  function checkVersion(r) {
    if (updatePrompted) return;
    const sv = r.headers.get("x-lianki-version");
    if (sv && isNewerVersion(sv, CURRENT_VERSION)) {
      updatePrompted = true;
      window.open(`${ORIGIN}/lianki.user.js`, "_blank");
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // Inline wrapper around GM_xmlhttpRequest — avoids gm-fetch's set-cookie
  // header bug that throws on strict mobile environments.
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: (opts.method || "GET").toUpperCase(),
        url: String(url),
        headers: opts.headers || {},
        data: opts.body ?? undefined,
        withCredentials: opts.credentials === "include",
        onload(resp) {
          const hdrs = {};
          for (const line of resp.responseHeaders.split("\r\n")) {
            const i = line.indexOf(": ");
            if (i > 0) {
              const name = line.slice(0, i).toLowerCase();
              if (name !== "set-cookie") hdrs[name] = line.slice(i + 2);
            }
          }
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            headers: { get: (n) => hdrs[n.toLowerCase()] ?? null },
            json() {
              try {
                return Promise.resolve(JSON.parse(resp.responseText));
              } catch {
                const preview = resp.responseText.slice(0, 120).replace(/\s+/g, " ").trim();
                return Promise.reject(new Error(`Login required (got: ${preview})`));
              }
            },
            text: () => Promise.resolve(resp.responseText),
          });
        },
        onerror() {
          reject(new Error("Network error"));
        },
        onabort() {
          reject(new Error("Request aborted"));
        },
      });
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  const api = (path, opts = {}) =>
    gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      checkVersion(r);
      return r.json();
    });

  // ── Cache (keyv-style, GM_setValue as cross-origin storage adapter) ────────
  function gmCache(key, ttlMs, fn) {
    try {
      const raw = GM_getValue(key);
      if (raw) {
        const { v, exp } = JSON.parse(raw);
        if (Date.now() < exp) return Promise.resolve(v);
      }
    } catch {}
    return fn().then((v) => {
      GM_setValue(key, JSON.stringify({ v, exp: Date.now() + ttlMs }));
      return v;
    });
  }

  function gmCacheInvalidate(key) {
    GM_setValue(key, "");
  }

  // ── API helpers ────────────────────────────────────────────────────────────
  const noteKey = (url) => `lk:note:${url}`;

  // Cache addNote by normalized URL for 10 min — skips round-trip on repeat visits
  const addNote = (url, title) =>
    gmCache(noteKey(url), 10 * 60 * 1000, () =>
      api("/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title }),
      }),
    );

  const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);
  const submitReview = (id, rating) =>
    api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}`);
  const deleteNote = (id) => api(`/api/fsrs/delete?id=${encodeURIComponent(id)}`);
  const getNextUrl = () => api("/api/fsrs/next-url");

  // ── Helpers ────────────────────────────────────────────────────────────────
  const btn = (bg, extra = "") =>
    `background:${bg};color:#eee;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;min-width:60px;${extra}`;

  function wouldHijackApp(url) {
    if (!isMobile) return false;
    try {
      const h = new URL(url).hostname;
      return MOBILE_APP_DOMAINS.some((d) => h === d || h.endsWith("." + d));
    } catch {
      return false;
    }
  }

  // ── FAB ────────────────────────────────────────────────────────────────────
  function createFab() {
    const el = document.createElement("button");
    el.textContent = "🔖";
    el.title = "Lianki (Alt+F)";
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483647",
      width: "44px",
      height: "44px",
      borderRadius: "50%",
      border: "none",
      background: "rgba(30,30,30,0.85)",
      fontSize: "20px",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      userSelect: "none",
    });

    try {
      const saved = JSON.parse(GM_getValue("lianki_pos", "null"));
      if (saved) {
        el.style.left = saved.x + "px";
        el.style.top = saved.y + "px";
      } else {
        el.style.right = "20px";
        el.style.bottom = "20px";
      }
    } catch {
      el.style.right = "20px";
      el.style.bottom = "20px";
    }

    let dragged = false;
    el.addEventListener("mousedown", (e) => {
      dragged = false;
      const ox = e.clientX - el.getBoundingClientRect().left;
      const oy = e.clientY - el.getBoundingClientRect().top;
      const onMove = (e2) => {
        dragged = true;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.left = e2.clientX - ox + "px";
        el.style.top = e2.clientY - oy + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        GM_setValue(
          "lianki_pos",
          JSON.stringify({ x: parseInt(el.style.left), y: parseInt(el.style.top) }),
        );
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    el.addEventListener("click", () => {
      if (!dragged) openDialog();
    });
    document.body.appendChild(el);
    return el;
  }

  // ── Dialog ─────────────────────────────────────────────────────────────────
  function mountDialog() {
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.45)",
      zIndex: "2147483645",
    });
    backdrop.addEventListener("click", closeDialog);

    const el = document.createElement("div");
    el.tabIndex = -1;
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483646",
      top: "50%",
      left: "50%",
      transform: "translate(-50%,-50%)",
      background: "#1e1e1e",
      color: "#eee",
      borderRadius: "12px",
      padding: "20px 24px",
      minWidth: "320px",
      maxWidth: "480px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      fontFamily: "system-ui,sans-serif",
      fontSize: "14px",
      outline: "none",
      lineHeight: "1.5",
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(el);
    el._backdrop = backdrop;
    return el;
  }

  function renderDialog() {
    if (!dialog) return;
    const { phase, options, error, message } = state;

    while (dialog.lastChild) dialog.removeChild(dialog.lastChild);

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "16px",
    });
    const titleSpan = document.createElement("span");
    Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
    titleSpan.textContent = "🔖 Lianki";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute(
      "style",
      `${btn("transparent")};color:#aaa;font-size:20px;padding:0 6px;line-height:1`,
    );
    closeBtn.addEventListener("click", closeDialog);
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Body
    if (phase === "adding") {
      const styleEl = document.createElement("style");
      styleEl.textContent =
        "@keyframes lk-spin{to{transform:rotate(360deg)}}" +
        ".lk-spinner{display:inline-block;width:20px;height:20px;" +
        "border:3px solid #555;border-top-color:#7eb8f7;border-radius:50%;" +
        "animation:lk-spin 0.8s linear infinite;vertical-align:middle;margin-right:8px}";
      dialog.appendChild(styleEl);

      const wrap = document.createElement("div");
      Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "10px" });
      const spinRow = document.createElement("div");
      Object.assign(spinRow.style, { fontSize: "15px", fontWeight: "600" });
      const spinner = document.createElement("span");
      spinner.className = "lk-spinner";
      spinRow.appendChild(spinner);
      spinRow.appendChild(document.createTextNode("Adding note\u2026"));
      const urlDiv = document.createElement("div");
      Object.assign(urlDiv.style, { color: "#888", fontSize: "12px", wordBreak: "break-all" });
      urlDiv.textContent = normalizeUrl(location.href);
      wrap.appendChild(spinRow);
      wrap.appendChild(urlDiv);
      dialog.appendChild(wrap);
    } else if (phase === "error") {
      const errDiv = document.createElement("div");
      errDiv.style.color = "#f77";
      errDiv.textContent = `Error: ${error}`;
      dialog.appendChild(errDiv);

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        marginTop: "10px",
        flexWrap: "wrap",
      });

      const loginBtn = document.createElement("button");
      loginBtn.setAttribute("style", btn("#2a5f8f"));
      loginBtn.textContent = "Login to Lianki";
      loginBtn.addEventListener("click", () => window.open(ORIGIN, "_blank"));
      btnRow.appendChild(loginBtn);

      const copyBtn = document.createElement("button");
      copyBtn.setAttribute("style", btn("#444"));
      copyBtn.textContent = "Copy error";
      copyBtn.addEventListener("click", () => {
        const text = `Error: ${error}`;
        (navigator.clipboard?.writeText(text) ?? Promise.reject()).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        });
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy error";
        }, 2000);
      });
      btnRow.appendChild(copyBtn);
      dialog.appendChild(btnRow);
    } else if (phase === "reviewing") {
      const titleDiv = document.createElement("div");
      Object.assign(titleDiv.style, {
        marginBottom: "12px",
        wordBreak: "break-all",
        fontSize: "13px",
        opacity: ".8",
      });
      const bold = document.createElement("b");
      bold.textContent = document.title || location.href;
      titleDiv.appendChild(bold);
      dialog.appendChild(titleDiv);

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
        marginBottom: "8px",
      });
      for (const o of options) {
        const b = document.createElement("button");
        b.setAttribute("style", btn("#2a5f8f"));
        b.appendChild(document.createTextNode(o.label));
        b.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        Object.assign(small.style, { opacity: ".7", fontSize: "11px" });
        small.textContent = o.due;
        b.appendChild(small);
        b.addEventListener("click", () => doReview(Number(o.rating)));
        btnRow.appendChild(b);
      }
      dialog.appendChild(btnRow);

      const deleteBtn = document.createElement("button");
      deleteBtn.setAttribute("style", btn("#7a2a2a"));
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", doDelete);
      dialog.appendChild(deleteBtn);

      const hints = document.createElement("div");
      Object.assign(hints.style, { marginTop: "14px", opacity: ".4", fontSize: "11px" });
      hints.textContent =
        "A/H=Easy \u00b7 S/J=Good \u00b7 W/K=Hard \u00b7 D/L=Again \u00b7 T/M=Delete \u00b7 Esc=Close";
      dialog.appendChild(hints);
    } else if (phase === "reviewed") {
      const msgDiv = document.createElement("div");
      Object.assign(msgDiv.style, { color: "#6f6", fontSize: "15px" });
      msgDiv.textContent = message;
      dialog.appendChild(msgDiv);
    }
  }

  // ── Open / Close ───────────────────────────────────────────────────────────
  function openDialog() {
    if (dialog) return;
    dialog = mountDialog();
    state = { phase: "adding", noteId: null, options: null, error: null, message: null };
    prefetchedNextUrl = null;
    renderDialog();
    dialog.focus();

    const url = normalizeUrl(location.href);
    addNote(url, document.title)
      .then((note) => {
        state.noteId = note._id;
        // Prefetch next URL in background while user reviews this card
        getNextUrl()
          .then((data) => {
            prefetchedNextUrl = data.url;
          })
          .catch(() => {});
        return getOptions(note._id);
      })
      .then((data) => {
        state.phase = "reviewing";
        state.options = data.options;
        renderDialog();
      })
      .catch((err) => {
        state.phase = "error";
        state.error = err.message;
        renderDialog();
      });
  }

  function closeDialog() {
    if (!dialog) return;
    dialog._backdrop?.remove();
    dialog.remove();
    dialog = null;
    state = { phase: "idle", noteId: null, options: null, error: null, message: null };
  }

  // ── Review actions ─────────────────────────────────────────────────────────
  async function doReview(rating) {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      await submitReview(state.noteId, rating);
      const opt = state.options.find((o) => Number(o.rating) === rating);
      await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      renderDialog();
    }
  }

  async function doDelete() {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      await deleteNote(state.noteId);
      gmCacheInvalidate(noteKey(normalizeUrl(location.href)));
      await afterReview("Deleted!");
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      renderDialog();
    }
  }

  async function afterReview(doneMessage) {
    state.phase = "reviewed";

    // Use prefetched URL if already ready — redirect is instant, no spinner
    let nextUrl = prefetchedNextUrl;
    let nextTitle = null;
    prefetchedNextUrl = null;

    if (!nextUrl) {
      state.message = "Loading next card\u2026";
      renderDialog();
      const data = await getNextUrl().catch(() => ({ url: null, title: null }));
      nextUrl = data.url;
      nextTitle = data.title;
      if (nextUrl) {
        state.message = `Redirecting to:\n${nextTitle || nextUrl}`;
        renderDialog();
      }
    }

    if (nextUrl && /^https?:\/\//.test(nextUrl) && !wouldHijackApp(nextUrl)) {
      GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
      location.href = nextUrl;
    } else {
      state.message = `${doneMessage} \u2014 All done!`;
      renderDialog();
      setTimeout(closeDialog, 2000);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const KEYS = {
    Digit1: () => doReview(1),
    KeyD: () => doReview(1),
    KeyL: () => doReview(1),
    Digit2: () => doReview(2),
    KeyW: () => doReview(2),
    KeyK: () => doReview(2),
    Digit3: () => doReview(3),
    KeyS: () => doReview(3),
    KeyJ: () => doReview(3),
    Digit4: () => doReview(4),
    KeyA: () => doReview(4),
    KeyH: () => doReview(4),
    Digit5: () => doDelete(),
    KeyT: () => doDelete(),
    KeyM: () => doDelete(),
    Escape: () => closeDialog(),
  };

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        if (dialog) closeDialog();
        else openDialog();
        return;
      }
      if (!dialog || state.phase !== "reviewing") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const action = KEYS[e.code];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    },
    { signal },
  );

  // ── Mount ──────────────────────────────────────────────────────────────────
  fab = createFab();

  // ── Redirect detection ─────────────────────────────────────────────────────
  // If Lianki navigated to a URL but the site auto-redirected to a different
  // one, update the card's stored URL to match the actual final location, then
  // auto-open the review dialog so the session continues uninterrupted.
  (async () => {
    try {
      const raw = GM_getValue("lk:nav_intended", "");
      if (!raw) return;
      const { url: intendedUrl, ts } = JSON.parse(raw);
      if (Date.now() - ts > 30_000) return; // 30 s TTL — stale, ignore
      GM_setValue("lk:nav_intended", ""); // consume so it only fires once
      const actualUrl = normalizeUrl(location.href);
      if (actualUrl === normalizeUrl(intendedUrl)) return; // no redirect happened
      await api("/api/fsrs/update-url", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl }),
      });
      openDialog();
    } catch {}
  })();

  // ── Cleanup ────────────────────────────────────────────────────────────────
  return () => {
    ac.abort();
    closeDialog();
    fab?.remove();
    fab = null;
  };
}
