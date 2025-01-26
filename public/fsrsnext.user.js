// ==UserScript==
// @name        FSRS Everywhere
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       none
// @version     1.0
// @author      -
// @description 2024/8/19 19:31:35
// @run-at      document-start
// ==/UserScript==

const effect = () => {
  let opened = false;
  const origin = "https://fsrsnext.snomiao.com";

  const openFsrs = (_url, target = "_blank") => {
    if (_url.startsWith("https://fsrsnext.snomiao.com")) return; // prevent open self
    if (_url.startsWith("https://fsrsnext.snomiao.dev")) return; // prevent open self
    const url = _url
      // for youtube
      // delete list and index &list=TLPQMjAwODIwMjQT4k3MtI2vbA&index=4
      .replace(/&list=[^&]+&index=\d+$/, "")
      .replace(/&bookpos=.*?&/, "&")
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
    if (target === "_blank")
      return parent.window.open(targetUrl, target, "noopener,noreferrer");
    if (target === "_self")
      return parent.window.open(targetUrl, target, "noopener,noreferrer");
    throw new Error("Error: no target");
  };
  // brainstorm
  // const goTTS = () => {
  //   const selected = window?.getSelection()?.toString().trim() || "";
  //   const q = selected.replace(/\n\n+/g, "\n");
  //   const ttsURL =
  //     "https://brainstorm.snomiao.dev/faq?" +
  //     new URLSearchParams({ a: selected }).toString();
  //   window.open(ttsURL);
  // };

  const eventListenerEffect = (target, ...args) => {
    target.addEventListener(...args);
    return () => target.removeEventListener(...args);
  };

  return eventListenerEffect(
    window,
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
      // if (e.code === "KeyT" && e.altKey && !e.shiftKey && !e.ctrlKey)
      //   goTTS(), e.stopPropagation(), e.preventDefault();
    },
    { capture: true }
  );
};

globalThis.unload_FSRSEverywhere?.();
globalThis.unload_FSRSEverywhere = effect();
