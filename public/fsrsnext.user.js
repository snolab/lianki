// ==UserScript==
// @name        FSRS Everywhere
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       none
// @version     1.1.1
// @author      snomiao@gmail.com
// @description fsrs everywhere
// @run-at      document-start
// @downloadURL https://fsrsnext.snomiao.com/fsrsnext.user.js
// @updateUrl   https://fsrsnext.snomiao.com/fsrsnext.user.js
// ==/UserScript==

globalThis.unload_FSRSEverywhere?.();
globalThis.unload_FSRSEverywhere = main();

function main() {
  const ac = new AbortController();
  const origin = "https://fsrsnext.snomiao.com";

  const openFsrs = (_url, target = "_blank") => {
    if (_url.match(/^https:\/\/fsrsnext.snomiao.(com|dev)/))
      location.href = location.origin; // go home if fsrs it self

    const url = _url
      // for youtube
      // delete list and index &list=..........................&index=1
      .replace(/&list=[^&]+&index=\d+$/, "")
      // for calibre, delete book pos
      .replace(/&bookpos=.*?&/, "&")
      // for leetcode, delete submissions
      .replace(
        /(?<=https:\/\/leetcode.com\/problems\/.*\/)submissions\/.*/,
        ""
      );

    if (url !== _url) {
      console.log("convert url", _url, "=>", url);
    }
    const title = parent.document.title || document.title;
    const repeatUrl =
      origin + "/repeat/?" + new URLSearchParams({ url, title }).toString();
    const addingUrl =
      origin + "/add-note#?" + new URLSearchParams({ url, title }).toString();
    const targetUrl = repeatUrl.length < 512 ? repeatUrl : addingUrl;
    // if (target === "_blank")
    //   return parent.window.open(targetUrl, target, "noopener,noreferrer");
    // if (target === "_self")
    //   return parent.window.open(targetUrl, target, "noopener,noreferrer");
    if (target === "_blank") {
      parent.window.open(targetUrl, "fsrsnext", "noopener,noreferrer");
      return;
    }
    if (target === "_self") {
      parent.window.open(targetUrl, "fsrsnext", "noopener,noreferrer");
      parent.window.close()
      return;
    }
    throw new Error("Error: no target");
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "KeyV" && e.altKey && !e.shiftKey && !e.ctrlKey) {
        openFsrs(parent?.location?.href || location.href, "_blank");
        e.stopPropagation();
        e.preventDefault();
      }
      if (e.code === "KeyF" && e.altKey && !e.shiftKey && !e.ctrlKey) {
        openFsrs(parent?.location?.href || location.href, "_self");
        e.stopPropagation();
        e.preventDefault();
      }
    },
    { capture: true, signal: ac.signal }
  );
  return () => {
    ac.abort();
  };
}
