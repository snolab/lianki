// ==UserScript==
// @name        FSRS Everywhere
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @version     9.0.0
// @author      snomiao@gmail.com
// @description This script has moved to Lianki. Please install the new version.
// @run-at      document-end
// @downloadURL https://fsrsnext.snomiao.com/fsrsnext.user.js
// @updateURL   https://fsrsnext.snomiao.com/fsrsnext.user.js
// ==/UserScript==

(function () {
  const banner = document.createElement("div");
  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "2147483647",
    background: "#1a1a2e",
    color: "#eee",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    padding: "12px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  });

  banner.innerHTML = `
    <span>
      ⚠️ <b>FSRSNext has been renamed to Lianki.</b>
      Please install the new userscript and uninstall this one:
      <a href="https://lianki.com/lianki.user.js"
         style="color:#7eb8f7;text-decoration:underline"
         target="_blank">lianki.com/lianki.user.js</a>
    </span>
    <button id="lk-dismiss" style="
      background:#444;color:#eee;border:none;border-radius:6px;
      padding:6px 12px;cursor:pointer;white-space:nowrap;flex-shrink:0
    ">Dismiss</button>`;

  document.body.prepend(banner);
  document.querySelector("#lk-dismiss").addEventListener("click", () => banner.remove());
})();
