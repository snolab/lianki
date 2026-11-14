/*
 * Lianki mini-app SDK (docs/mini-apps.md, "The SDK"). Loaded into every mini
 * app before its own code; defines window.lianki. Each call is a postMessage
 * to the host page (lianki.com/m/<slug>), which asks the user the first time
 * a capability is used and answers with the result. The app holds no token
 * and has no network: everything goes through here.
 *
 *   await lianki.request("storage")          // "granted" | "denied" | "prompt" | "undeclared"
 *   await lianki.storage.set("total", 42); await lianki.storage.get("total"); await lianki.storage.list()
 *   await lianki.prefs.get(); await lianki.prefs.set("ui.paper", "b")
 *   await lianki.chat.read(10); await lianki.chat.say("Done: 6 × 7 = 42")
 *   await lianki.ui.card({ title: "Keep this result?", options: ["Yes", "No"] })  // → "Yes" | "No" | null
 *
 * A refused call rejects with an Error whose .code is the reason
 * (permission-denied, permission-undeclared, storage-full, …).
 */
(function () {
  "use strict";
  if (window.lianki) return;
  var PROTOCOL = "mini/1";
  var next = 1;
  var waiting = {};
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    // The host's theme (night mode follows the site): <html data-theme>.
    if (
      m &&
      m.lk === PROTOCOL &&
      m.event === "theme" &&
      (m.theme === "dark" || m.theme === "light")
    ) {
      document.documentElement.setAttribute("data-theme", m.theme);
      return;
    }
    if (!m || m.lk !== PROTOCOL || typeof m.id !== "number" || !waiting[m.id]) return;
    var w = waiting[m.id];
    delete waiting[m.id];
    if (m.ok) w.resolve(m.result);
    else {
      var err = new Error(m.error || "failed");
      err.code = m.error || "failed";
      if (m.permission) err.permission = m.permission;
      w.reject(err);
    }
  });
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = next++;
      waiting[id] = { resolve: resolve, reject: reject };
      // The host checks this window is its frame; an opaque sandbox origin cannot be named, so "*".
      window.parent.postMessage({ lk: PROTOCOL, id: id, method: method, args: args || {} }, "*");
    });
  }
  var pick = function (key) {
    return function (r) {
      return r ? r[key] : undefined;
    };
  };
  window.lianki = Object.freeze({
    version: PROTOCOL,
    manifest: function () {
      return call("manifest");
    },
    request: function (permission) {
      return call("request", { permission: permission });
    },
    storage: Object.freeze({
      get: function (key) {
        return call("storage.get", { key: key }).then(pick("value"));
      },
      set: function (key, value) {
        return call("storage.set", { key: key, value: value === undefined ? null : value }).then(
          function () {},
        );
      },
      list: function (prefix) {
        return call("storage.list", { prefix: prefix || "" });
      },
    }),
    prefs: Object.freeze({
      get: function (keys) {
        return call("prefs.get", keys ? { keys: keys } : {}).then(pick("prefs"));
      },
      set: function (key, value) {
        return call("prefs.set", { key: key, value: value }).then(function () {});
      },
    }),
    chat: Object.freeze({
      read: function (limit) {
        return call("chat.read", { limit: limit || 20 }).then(pick("lines"));
      },
      say: function (text) {
        return call("chat.say", { text: String(text) }).then(pick("id"));
      },
    }),
    ui: Object.freeze({
      card: function (card) {
        return call("ui.card", card || {}).then(pick("choice"));
      },
    }),
  });
})();
