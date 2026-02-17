// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_info
// @version     2.0.0
// @author      snomiao@gmail.com
// @description Lianki spaced repetition — inline review without page navigation
// @run-at      document-end
// @downloadURL https://lianki.com/lianki.user.js
// @updateURL   https://lianki.com/lianki.user.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     beta.lianki.com
// @require     https://github.com/trim21/gm-fetch/releases/latest/download/gm-fetch.js
// ==/UserScript==

globalThis.unload_Lianki?.();
globalThis.unload_Lianki = main();

function main() {
  // ── Origin (auto-detected from @downloadURL so beta.lianki.com works too) ──
  const ORIGIN = (() => {
    try {
      return new URL(GM_info?.script?.downloadURL || "").origin;
    } catch {
      return "https://lianki.com";
    }
  })();

  // Skip running on the Lianki app itself
  if (location.origin === ORIGIN) return () => {};

  const ac = new AbortController();
  const { signal } = ac;

  // ── State ──────────────────────────────────────────────────────────────────
  let state = { phase: "idle", noteId: null, options: null, error: null, message: null };
  let fab = null;
  let dialog = null;

  // ── API ────────────────────────────────────────────────────────────────────
  const api = (path, opts = {}) =>
    gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

  const addNote = (url, title) =>
    api("/api/fsrs/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, title }),
    });

  const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);

  const submitReview = (id, rating) =>
    api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}`);

  const deleteNote = (id) => api(`/api/fsrs/delete?id=${encodeURIComponent(id)}`);

  const getNextUrl = () => api("/api/fsrs/next-url");

  // ── Helpers ────────────────────────────────────────────────────────────────
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const btn = (bg, extra = "") =>
    `background:${bg};color:#eee;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;min-width:60px;${extra}`;

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

    const saved = (() => {
      try {
        return JSON.parse(GM_getValue("lianki_pos", "null"));
      } catch {
        return null;
      }
    })();
    if (saved) {
      el.style.left = saved.x + "px";
      el.style.top = saved.y + "px";
    } else {
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
    let body = "";

    if (phase === "adding") {
      body = `<div style="color:#aaa">Adding…<br><small style="opacity:.6;word-break:break-all">${esc(location.href)}</small></div>`;
    } else if (phase === "error") {
      body = `<div style="color:#f77">Error: ${esc(error)}<br><small>Are you logged in to Lianki?</small></div>`;
    } else if (phase === "reviewing") {
      const ratingBtns = options
        .map(
          (o) =>
            `<button data-rating="${o.rating}" style="${btn("#2a5f8f")}">${esc(o.label)}<br><small style="opacity:.7;font-size:11px">${esc(o.due)}</small></button>`,
        )
        .join("");
      body = `
        <div style="margin-bottom:12px;word-break:break-all;font-size:13px;opacity:.8">
          <b>${esc(document.title || location.href)}</b>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${ratingBtns}</div>
        <div><button data-delete style="${btn("#7a2a2a")}">Delete</button></div>
        <div style="margin-top:14px;opacity:.4;font-size:11px">
          A/H=Easy &nbsp;·&nbsp; S/J=Good &nbsp;·&nbsp; W/K=Hard &nbsp;·&nbsp; D/L=Again &nbsp;·&nbsp; T/M=Delete &nbsp;·&nbsp; Esc=Close
        </div>`;
    } else if (phase === "reviewed") {
      body = `<div style="color:#6f6;font-size:15px">${esc(message)}</div>`;
    }

    dialog.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <span style="font-weight:700;font-size:16px">🔖 Lianki</span>
        <button id="lk-close" style="${btn("transparent")};color:#aaa;font-size:20px;padding:0 6px;line-height:1">×</button>
      </div>
      ${body}`;

    dialog.querySelector("#lk-close")?.addEventListener("click", closeDialog);
    dialog.querySelectorAll("[data-rating]").forEach((b) => {
      b.addEventListener("click", () => doReview(Number(b.dataset.rating)));
    });
    dialog.querySelector("[data-delete]")?.addEventListener("click", doDelete);
  }

  // ── Open / Close ───────────────────────────────────────────────────────────
  function openDialog() {
    if (dialog) return;
    dialog = mountDialog();
    state = { phase: "adding", noteId: null, options: null, error: null, message: null };
    renderDialog();
    dialog.focus();

    addNote(location.href, document.title)
      .then((note) => {
        state.noteId = note._id;
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
      const opt = state.options.find((o) => o.rating === rating);
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
      await afterReview("Deleted!");
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      renderDialog();
    }
  }

  async function afterReview(message) {
    const { url: nextUrl } = await getNextUrl().catch(() => ({ url: null }));
    state.phase = "reviewed";
    state.message = nextUrl ? `${message} — navigating to next card…` : `${message} — All done!`;
    renderDialog();

    if (nextUrl) {
      sessionStorage.setItem("lianki_auto_open", "1");
      setTimeout(() => (location.href = nextUrl), 1500);
    } else {
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
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        dialog ? closeDialog() : openDialog();
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

  // ── Auto-open after navigation ─────────────────────────────────────────────
  if (sessionStorage.getItem("lianki_auto_open")) {
    sessionStorage.removeItem("lianki_auto_open");
    setTimeout(openDialog, 500);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  fab = createFab();

  // ── Cleanup ────────────────────────────────────────────────────────────────
  return () => {
    ac.abort();
    closeDialog();
    fab?.remove();
    fab = null;
  };
}
