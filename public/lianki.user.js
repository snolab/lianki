// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_info
// @version     2.17.0
// @author      lianki.com
// @description Lianki spaced repetition — inline review without page navigation. Press , or . (or media keys) to control video speed with difficulty markers.
// @run-at      document-end
// @downloadURL https://www.lianki.com/lianki.user.js
// @updateURL   https://www.lianki.com/lianki.meta.js
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
  let state = {
    phase: "idle",
    noteId: null,
    options: null,
    error: null,
    message: null,
    notes: "",
    notesSynced: true,
  };
  let fab = null;
  let dialog = null;
  let prefetchedNextUrl = null; // populated while user reads current card
  let prefetchLink = null; // <link rel="prefetch"> element for next page

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
      const token = GM_getValue("lk:token", "");
      const headers = { ...opts.headers };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      GM_xmlhttpRequest({
        method: (opts.method || "GET").toUpperCase(),
        url: String(url),
        headers,
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
                const err = new Error(`Login required (got: ${preview})`);
                err.details = resp.responseText.slice(0, 2000);
                err.statusCode = resp.status;
                return Promise.reject(err);
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
      if (r.status === 401) throw new Error("Login required");
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

  // Build excludeDomains query param for filtering next card
  const buildExcludeDomainsParam = () => {
    if (!isMobile) return "";
    return `&excludeDomains=${MOBILE_APP_DOMAINS.join(",")}`;
  };

  const saveNotes = (id, notes) =>
    api(`/api/fsrs/notes?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);
  const submitReview = (id, rating) =>
    api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const deleteNote = (id) =>
    api(`/api/fsrs/delete?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const getNextUrl = () => api(`/api/fsrs/next-url?${buildExcludeDomainsParam().slice(1)}`);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const btn = (bg, extra = "") =>
    `background:${bg};color:#eee;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;min-width:60px;${extra}`;

  // Prefetch next page for faster navigation
  function prefetchNextPage(pageUrl) {
    if (!pageUrl) return;

    // Remove old prefetch link if exists
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }

    // Create and append new prefetch link
    prefetchLink = document.createElement("link");
    prefetchLink.rel = "prefetch";
    prefetchLink.href = pageUrl;
    prefetchLink.as = "document";
    document.head.appendChild(prefetchLink);
    console.log("[Lianki] Prefetching next page:", pageUrl);
  }

  // ── UI: combined FAB + speed controls ─────────────────────────────────────
  function createUI() {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      zIndex: "2147483647",
      display: "flex",
      gap: "6px",
      alignItems: "center",
      userSelect: "none",
      touchAction: "none",
    });

    let isDragged = false;
    const PILL = "padding:10px 14px;border-radius:999px;font-size:15px;font-weight:bold;";
    const CIRCLE = "width:44px;height:44px;border-radius:50%;font-size:20px;";
    const BASE =
      "border:none;cursor:pointer;background:rgba(20,20,20,0.82);color:#eee;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.4);touch-action:manipulation;" +
      "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);";
    const makeBtn = (text, title, action, shape) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.style.cssText = BASE + shape;
      b.addEventListener("click", (e) => {
        if (isDragged) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        action();
      });
      return b;
    };

    container.append(
      makeBtn("⏪", "Slower (,)", () => pardon(-3, 0.7), PILL),
      makeBtn("🔖", "Lianki (Alt+F)", () => (dialog ? closeDialog() : openDialog()), CIRCLE),
      makeBtn("⏩", "Faster (.)", () => pardon(0, 1.2), PILL),
    );

    let dragging = false;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0;

    const initDrag = (clientX, clientY) => {
      isDragged = false;
      dragging = true;
      const r = container.getBoundingClientRect();
      startX = clientX;
      startY = clientY;
      startLeft = r.left;
      startTop = r.top;
      container.style.right = "auto";
      container.style.bottom = "auto";
      container.style.left = startLeft + "px";
      container.style.top = startTop + "px";
    };
    const moveDrag = (clientX, clientY) => {
      if (!dragging) return;
      const dx = clientX - startX,
        dy = clientY - startY;
      if (!isDragged && Math.abs(dx) + Math.abs(dy) > 6) {
        isDragged = true;
        const r = container.getBoundingClientRect();
        startLeft = clientX - r.width / 2;
        startTop = clientY - r.height / 2;
        startX = clientX;
        startY = clientY;
      }
      if (isDragged) {
        const r = container.getBoundingClientRect();
        const newLeft = startLeft + (clientX - startX);
        const newTop = startTop + (clientY - startY);
        container.style.left = Math.max(0, Math.min(window.innerWidth - r.width, newLeft)) + "px";
        container.style.top = Math.max(0, Math.min(window.innerHeight - r.height, newTop)) + "px";
      }
    };
    const stopDrag = () => {
      if (isDragged) {
        GM_setValue(
          "lianki_pos",
          JSON.stringify({ x: parseInt(container.style.left), y: parseInt(container.style.top) }),
        );
      }
      dragging = false;
    };

    container.addEventListener(
      "touchstart",
      (e) => initDrag(e.touches[0].clientX, e.touches[0].clientY),
      { passive: true },
    );
    container.addEventListener(
      "touchmove",
      (e) => {
        if (dragging) {
          e.preventDefault();
          moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: false },
    );
    container.addEventListener("touchend", stopDrag, { passive: true });
    container.addEventListener("mousedown", (e) => {
      initDrag(e.clientX, e.clientY);
      const onMove = (ev) => moveDrag(ev.clientX, ev.clientY);
      const onUp = () => {
        stopDrag();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    document.body.appendChild(container);
    // Load saved position after mount so getBoundingClientRect gives real width
    try {
      const saved = JSON.parse(GM_getValue("lianki_pos", "null"));
      if (saved) {
        const r = container.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - r.width, saved.x));
        const y = Math.max(0, Math.min(window.innerHeight - r.height, saved.y));
        container.style.right = "auto";
        container.style.bottom = "auto";
        container.style.left = x + "px";
        container.style.top = y + "px";
      } else {
        container.style.right = "12px";
        container.style.bottom = "20px";
      }
    } catch {
      container.style.right = "12px";
      container.style.bottom = "20px";
    }
    return container;
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
      maxWidth: "min(480px, 90vw)",
      maxHeight: "90vh",
      overflowY: "auto",
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

      const tokenBtn = document.createElement("button");
      tokenBtn.setAttribute("style", btn("#3a6f3f"));
      tokenBtn.textContent = "Set API Token";
      tokenBtn.addEventListener("click", () => {
        const token = prompt(
          `Paste your Lianki API token.\n\nGenerate one at: ${ORIGIN}/list\n\n(Needed for Safari/Stay where cookies don't work)`,
        );
        if (!token) return;
        GM_setValue("lk:token", token.trim());
        closeDialog();
        openDialog(); // retry with token
      });
      btnRow.appendChild(tokenBtn);

      const copyBtn = document.createElement("button");
      copyBtn.setAttribute("style", btn("#444"));
      copyBtn.textContent = "Copy error";
      copyBtn.addEventListener("click", () => {
        const parts = [
          `Error: ${error}`,
          `Page: ${location.href}`,
          `Origin: ${ORIGIN}`,
          `Version: ${CURRENT_VERSION}`,
        ];
        if (state.errorDetails) parts.push(`\nResponse:\n${state.errorDetails}`);
        const text = parts.join("\n");
        navigator.clipboard?.writeText(text).catch(() => {
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

      // Notes input
      const notesRow = document.createElement("div");
      Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });

      const notesInput = document.createElement("input");
      notesInput.type = "text";
      notesInput.maxLength = 128;
      notesInput.placeholder = "Notes\u2026";
      notesInput.value = state.notes;
      notesInput.tabIndex = -1; // Don't auto-focus (preserve hotkeys)
      Object.assign(notesInput.style, {
        width: "100%",
        boxSizing: "border-box",
        background: "#222",
        color: "#ddd",
        border: "1px solid #444",
        borderRadius: "6px",
        padding: "6px 28px 6px 8px",
        fontSize: "12px",
        outline: "none",
      });

      const syncIndicator = document.createElement("span");
      Object.assign(syncIndicator.style, {
        position: "absolute",
        right: "8px",
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: "13px",
        opacity: ".7",
        pointerEvents: "none",
      });
      syncIndicator.textContent = state.notesSynced ? "\u2713" : "\u22ef";

      let notesTimer = null;
      notesInput.addEventListener("input", () => {
        const val = notesInput.value.slice(0, 128);
        state.notes = val;
        state.notesSynced = false;
        syncIndicator.textContent = "\u22ef"; // ellipsis = pending
        clearTimeout(notesTimer);
        notesTimer = setTimeout(async () => {
          try {
            await saveNotes(state.noteId, val);
            state.notesSynced = true;
            syncIndicator.textContent = "\u2713"; // checkmark = synced
          } catch {
            syncIndicator.textContent = "\u2717"; // cross = error
          }
        }, 1000);
      });

      notesRow.appendChild(notesInput);
      notesRow.appendChild(syncIndicator);
      dialog.appendChild(notesRow);
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
        state.notes = note.notes ?? "";
        state.notesSynced = true;
        // Prefetch next URL in background while user reviews this card
        getNextUrl()
          .then((data) => {
            prefetchedNextUrl = data.url;
            if (data.url) prefetchNextPage(data.url);
          })
          .catch(() => {});
        // Use options from add-card response if available (optimization)
        if (note.options) {
          return { options: note.options };
        }
        // Fallback for older API versions
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
        state.errorDetails = err.details ?? null;
        renderDialog();
      });
  }

  function closeDialog() {
    if (!dialog) return;
    dialog._backdrop?.remove();
    dialog.remove();
    dialog = null;
    state = { phase: "idle", noteId: null, options: null, error: null, message: null };

    // Clean up prefetch link when closing dialog
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }
  }

  // ── Review actions ─────────────────────────────────────────────────────────
  async function doReview(rating) {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      const result = await submitReview(state.noteId, rating);
      // Use nextUrl from review response if available (optimization)
      if (result.nextUrl) {
        prefetchedNextUrl = result.nextUrl;
        prefetchNextPage(result.nextUrl);
      }
      const opt = state.options.find((o) => Number(o.rating) === rating);
      await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  }

  async function doDelete() {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      const result = await deleteNote(state.noteId);
      gmCacheInvalidate(noteKey(normalizeUrl(location.href)));
      // Use nextUrl from delete response if available (optimization)
      if (result.nextUrl) {
        prefetchedNextUrl = result.nextUrl;
        prefetchNextPage(result.nextUrl);
      }
      await afterReview("Deleted!");
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
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
        prefetchNextPage(nextUrl);
        state.message = `Redirecting to:\n${nextTitle || nextUrl}`;
        renderDialog();
      }
    }

    if (nextUrl && /^https?:\/\//.test(nextUrl)) {
      // Normal navigation to next card (backend already filtered hijacking domains)
      console.log("[Lianki] Storing intended URL:", nextUrl);
      GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
      location.href = nextUrl;
    } else {
      // No more cards or invalid URL
      state.message = `${doneMessage} — All done!`;
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

  // ── Media Keys ─────────────────────────────────────────────────────────────
  // Support hardware media keys (headphones, keyboards, etc.)
  // nexttrack = faster (1.2x), previoustrack = slower + rewind (-3s, 0.7x)
  (() => {
    let vcid = null;
    document.addEventListener("visibilitychange", trackHandler, { signal });
    function trackHandler() {
      const cb = () => {
        if (!navigator.mediaSession) return;
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          pardon(0, 1.2); // Faster
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          pardon(-3, 0.7); // Rewind 3s and slower
        });
      };
      if (document.visibilityState === "hidden") {
        vcid = void clearInterval(vcid);
      } else {
        cb();
        vcid ??= setInterval(cb, 1000);
      }
    }
    trackHandler();
  })();

  // ── Mount ──────────────────────────────────────────────────────────────────
  fab = createUI();

  // ── Redirect detection ─────────────────────────────────────────────────────
  // If Lianki navigated to a URL but the site auto-redirected to a different
  // one, update the card's stored URL to match the actual final location, then
  // auto-open the review dialog so the session continues uninterrupted.
  // Also handles pushState/replaceState URL changes.

  async function checkRedirect() {
    try {
      const raw = GM_getValue("lk:nav_intended", "");
      if (!raw) return;
      const { url: intendedUrl, ts } = JSON.parse(raw);
      if (Date.now() - ts > 30_000) return; // 30 s TTL — stale, ignore
      const actualUrl = location.href;
      if (normalizeUrl(actualUrl) === normalizeUrl(intendedUrl)) {
        GM_setValue("lk:nav_intended", ""); // no redirect, clear it
        return;
      }

      console.log("[Lianki] Redirect detected:", intendedUrl, "→", actualUrl);

      // Ask user if they want to update the card URL
      const confirmed = confirm(
        `This page redirected from:\n${intendedUrl}\n\n` +
          `To:\n${actualUrl}\n\n` +
          `Update the card to point to the new URL?`,
      );

      if (!confirmed) {
        console.log("[Lianki] User declined URL update");
        GM_setValue("lk:nav_intended", ""); // user declined, clear it
        return;
      }

      const result = await api("/api/fsrs/update-url", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl }),
      });
      console.log("[Lianki] Card URL updated:", result);
      GM_setValue("lk:nav_intended", ""); // only clear after success
      openDialog();
    } catch (err) {
      console.error("[Lianki] Failed to update card URL:", err);
      // Don't clear GM_setValue - retry on next page load
    }
  }

  // Check on page load
  checkRedirect();

  // Monitor URL changes for SPA redirects
  if ("navigation" in window) {
    // Modern Navigation API (Chrome 102+, Edge 102+)
    navigation.addEventListener("navigatesuccess", () => checkRedirect(), { signal });
  } else {
    // Fallback: wrap history methods for older browsers
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    // Also listen to popstate (back/forward buttons)
    window.addEventListener("popstate", () => setTimeout(checkRedirect, 100), { signal });
  }

  // ── Video Speed Control (Pardon) ───────────────────────────────────────────
  // Press , (slower) or . (faster) to adjust video speed. Speed adjustments are
  // remembered as "difficulty markers" and auto-applied during playback.

  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const renderTime = (t) =>
    [(t / 3600) | 0, ((t / 60) | 0) % 60, (t % 60) | 0]
      .map((e) => e.toString().padStart(2, "0"))
      .join(":");
  const renderSpeed = (s) => "x" + s.toFixed(2);

  function centerTooltip(textContent) {
    const el = document.createElement("div");
    el.textContent = textContent;
    el.style.cssText =
      "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " +
      "background: #0008; color: white; padding: 0.5rem; border-radius: 1rem; " +
      "z-index: 2147483647; pointer-events: none;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }

  // Speed map: WeakMap<videoElement, Map<timestamp, speed>>
  const videoSpeedMaps = new WeakMap();

  // GM_setValue cache helpers for persistent storage
  const markerCacheKey = (url) => `lk:markers:${normalizeUrl(url)}`;

  function loadLocalMarkers(url) {
    try {
      const raw = GM_getValue(markerCacheKey(url), "");
      if (!raw) return { markers: {}, lastSync: 0, dirty: false };
      return JSON.parse(raw);
    } catch {
      return { markers: {}, lastSync: 0, dirty: false };
    }
  }

  function saveLocalMarkers(url, markers, dirty = true) {
    const cache = {
      markers,
      lastSync: dirty ? loadLocalMarkers(url).lastSync : Date.now(),
      dirty,
    };
    GM_setValue(markerCacheKey(url), JSON.stringify(cache));
  }

  async function pardon(dt = 0, speedMultiplier = 1, wait = 0) {
    const vs = $$("video,audio");
    const v = vs.filter((e) => !e.paused)[0];
    if (!v) return vs[0]?.click();

    // Helper to merge nearby markers (within 2 seconds)
    const mergeNearbyMarkers = (time) => {
      if (speedMultiplier === 1) return; // Only merge when speed is being adjusted
      if (!videoSpeedMaps.has(v)) videoSpeedMaps.set(v, new Map());
      const speedMap = videoSpeedMaps.get(v);
      const MERGE_THRESHOLD = 2.0; // seconds
      for (const [existingTime] of speedMap) {
        if (Math.abs(time - existingTime) < MERGE_THRESHOLD) {
          speedMap.delete(existingTime);
          console.log(`[Lianki] Merged marker: ${renderTime(existingTime)} @ ${renderTime(time)}`);
        }
      }
    };

    // Merge at original position BEFORE time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (dt !== 0) v.currentTime += dt;

    // Merge at destination position AFTER time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (speedMultiplier !== 1) {
      v.playbackRate *= speedMultiplier;

      // Speed map already initialized by mergeNearbyMarkers
      const speedMap = videoSpeedMaps.get(v);

      // Add new marker at final position
      speedMap.set(v.currentTime, v.playbackRate);
      console.log(
        `[Lianki] Speed marker: ${renderTime(v.currentTime)} → ${renderSpeed(v.playbackRate)}`,
      );

      // Save to local cache (GM_setValue)
      const url = normalizeUrl(location.href);
      const markers = Object.fromEntries(speedMap);
      saveLocalMarkers(url, markers, true); // dirty = true
    }

    centerTooltip(
      (dt < 0 ? "<-" : "->") + " " + renderTime(v.currentTime) + " " + renderSpeed(v.playbackRate),
    );

    if (wait) await sleep(wait);
    return true;
  }

  // Keyboard shortcuts for video speed control
  window.addEventListener(
    "keydown",
    async (e) => {
      // Skip if Lianki dialog is open or in input fields
      if (dialog) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (document?.activeElement?.isContentEditable) return;
      if (["INPUT", "TEXTAREA"].includes(document?.activeElement?.tagName)) return;

      if (e.code === "Comma") {
        if (await pardon(-3, 0.7)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      if (e.code === "Period") {
        if (await pardon(0, 1.2)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    { capture: true },
  );

  // Auto-adjust speed at marked timestamps
  function setupVideoSpeedTracking(video) {
    const url = normalizeUrl(location.href);

    // Load markers from DB → GM_setValue → WeakMap
    (async () => {
      try {
        const local = loadLocalMarkers(url);

        // Always fetch from DB for cross-device sync
        const { markers } = await api(`/api/fsrs/speed-markers?url=${encodeURIComponent(url)}`);

        // Merge: server wins for conflicts, use latest
        const merged = { ...local.markers, ...markers };

        // Save to local cache
        saveLocalMarkers(url, merged, false); // not dirty, just synced

        // Load into WeakMap for this video
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(merged)) {
          speedMap.set(parseFloat(timestamp), speed);
        }

        console.log(`[Lianki] Loaded ${Object.keys(merged).length} speed markers for ${url}`);
      } catch (err) {
        console.error("[Lianki] Failed to load speed markers:", err);
        // Fall back to local cache
        const local = loadLocalMarkers(url);
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(local.markers)) {
          speedMap.set(parseFloat(timestamp), speed);
        }
      }
    })();

    let lastCheckedTime = 0;

    video.addEventListener("timeupdate", () => {
      const speedMap = videoSpeedMaps.get(video);
      if (!speedMap || speedMap.size === 0) return;

      const currentTime = video.currentTime;
      const threshold = 0.5; // 500ms window

      // Only check if we've moved significantly (avoid spam)
      if (Math.abs(currentTime - lastCheckedTime) < 0.3) return;
      lastCheckedTime = currentTime;

      // Find nearest marker
      for (const [markedTime, targetSpeed] of speedMap) {
        if (Math.abs(currentTime - markedTime) < threshold) {
          if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
            video.playbackRate = targetSpeed;
            centerTooltip(`Auto-speed: ${renderSpeed(targetSpeed)} @ ${renderTime(markedTime)}`);
            console.log(
              `[Lianki] Auto-adjusted to ${renderSpeed(targetSpeed)} at ${renderTime(currentTime)}`,
            );
          }
          break; // Only apply one marker per check
        }
      }
    });
  }

  // Detect and track all video/audio elements
  function observeVideos() {
    const tracked = new WeakSet();

    const trackVideo = (v) => {
      if (tracked.has(v)) return;
      tracked.add(v);
      setupVideoSpeedTracking(v);
    };

    // Track existing videos
    $$("video,audio").forEach(trackVideo);

    // Track future videos
    const observer = new MutationObserver(() => {
      $$("video,audio").forEach(trackVideo);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  observeVideos();

  // Periodic sync to DB (every 30s)
  setInterval(async () => {
    try {
      const url = normalizeUrl(location.href);
      const cache = loadLocalMarkers(url);

      if (!cache.dirty) return; // No changes to sync

      console.log(`[Lianki] Syncing ${Object.keys(cache.markers).length} markers to DB...`);

      await api("/api/fsrs/speed-markers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, markers: cache.markers }),
      });

      // Mark as synced
      saveLocalMarkers(url, cache.markers, false); // dirty = false
      console.log("[Lianki] Sync complete");
    } catch (err) {
      console.error("[Lianki] Sync failed:", err);
      // Keep dirty flag, will retry in 30s
    }
  }, 30_000); // 30 seconds

  // ── Cleanup ────────────────────────────────────────────────────────────────
  return () => {
    ac.abort();
    closeDialog();
    fab?.remove();
    fab = null;
  };
}
