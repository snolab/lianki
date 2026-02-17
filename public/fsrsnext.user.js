// ==UserScript==
/** biome-ignore-all lint/suspicious/noAssignInExpressions: userscript code */
// @name        FSRS Everywhere
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       none
// @version     1.2.1
// @author      snomiao@gmail.com
// @description fsrs everywhere
// @run-at      document-start
// @downloadURL https://fsrsnext.snomiao.com/fsrsnext.user.js
// @updateURL   https://fsrsnext.snomiao.com/fsrsnext.user.js
// ==/UserScript==

globalThis.unload_FSRSEverywhere?.();
globalThis.unload_FSRSEverywhere = main();

function main() {
  const ac = new AbortController();
  const origin = "https://fsrsnext.snomiao.com";

  const openFsrs = (_urlOrAnchor, target = "_blank") => {
    const _url = _urlOrAnchor.href ? _urlOrAnchor.href : _urlOrAnchor;

    if (_url.match(/^https:\/\/fsrsnext.snomiao.(com|dev)/)) location.href = location.origin; // go home if fsrs it self

    const url = fsrsUrlClean(_url);

    const title = _urlOrAnchor.href
      ? _urlOrAnchor.textContent.trim()
      : parent.document.title || document.title;

    const repeatUrl = `${origin}/repeat/?${new URLSearchParams({
      url,
      title,
    }).toString()}`;
    const addingUrl = `${origin}/add-note#?${new URLSearchParams({
      url,
      title,
    }).toString()}`;
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
      parent.window.close();
      return;
    }
    throw new Error("Error: no target");
  };

  window.addEventListener(
    "keydown",
    (e) => {
      const actions = {
        "alt+f": () => openFsrs(parent?.location?.href || location.href, "_self"),
        "alt+v": () => openFsrs(parent?.location?.href || location.href, "_blank"),
        // add all now
        "alt+shift+v": async () => {
          const anchors = getMainAnchorsList();
          if (anchors.length === 0) return alert("no link found");
          const msg = `Found ${anchors.length} links, open fsrs for all?\n ${anchors
            .map((a) => `- [${a.textContent.trim()}](${fsrsUrlClean(a.href)})`)
            .join("\n")}`;
          if (!confirm(msg)) return alert("user aborted");
          anchors.map((a) => openFsrs(fsrsUrlClean(a.href), "_blank"));
        },
        // view all now
        // "alt+shift+v": async () => {
        //   const anchors = getMainAnchorsList();
        //   if (anchors.length === 0) return alert("no link found");
        //   const msg = `Found ${anchors.length} links, open all?\n ${anchors
        //     .map((a) => `- [${a.textContent.trim()}](${fsrsUrlClean(a.href)})`)
        //     .join("\n")}`;
        //   if (!confirm(msg)) return alert("user aborted");

        //   // all page order: [targetpage, fsrspage, targetpage, fsrspage, ...]
        //   // 8 pages as a batch in reverse order
        //   /** @type {Array<Array<HTMLAnchorElement>>} */
        //   const batches = Object.values(
        //     Object.groupBy(anchors, (e, i) => String(Math.floor(i / 8)))
        //   );
        //   for await (const batch of batches) {
        //     for (const anchor of batch.toReversed()) {
        //       const url = fsrsUrlClean(anchor.href);
        //       openFsrs(url, "_blank");
        //       window.open(url, "_blank");
        //     }
        //     await new Promise((r) => setTimeout(r, 1e3)); // 1s cd
        //     await new Promise((r) =>
        //       document.addEventListener("visibilitychange", r, {
        //         once: true,
        //       })
        //     ); // wait for page visible for next batch
        //   }
        // },
      };
      for (const [hotkey, action] of Object.entries(actions)) {
        if (hotkeyEventMatcher(hotkey)(e)) {
          e.stopPropagation();
          e.preventDefault();
          try {
            const ret = action();
            if (ret instanceof Promise) ret.catch(console.error);
          } catch (err) {
            console.error(err);
            alert(err.message);
          }
        }
      }
    },
    { signal: ac.signal },
  );
  return () => {
    ac.abort();
  };
}

/**
 * Parse a hotkey string (e.g. "Ctrl+Shift+X") and return a function that
 * checks if a keyboard event matches the hotkey.
 * Supports modifier keys: Ctrl, Alt, Shift, Meta (Cmd on Mac)
 * Supports character keys and special keys (e.g. Enter, Escape)
 * @param {string} hotkey - The hotkey string to parse
 * @returns {(event: KeyboardEvent) => boolean} - Function to check if event matches hotkey
 */
const hotkeyEventMatcher = (hotkey) => (event) => {
  const keys = hotkey
    .toLowerCase()
    .split("+")
    .map((k) => k.trim());
  const keySet = new Set(keys);
  if (keySet.has("ctrl") !== event.ctrlKey) return false;
  if (keySet.has("alt") !== event.altKey) return false;
  if (keySet.has("shift") !== event.shiftKey) return false;
  if (keySet.has("meta") !== event.metaKey) return false;
  const key = keys.find((k) => !["ctrl", "alt", "shift", "meta"].includes(k));
  if (!key) return false;
  if (key.length === 1) {
    return event.key.toLowerCase() === key; // character key
  } else {
    return event.code.toLowerCase().replace(/key$/, "") === key; // special key
  }
};

function fsrsUrlClean(_url) {
  const converted = _url
    // for youtube
    // delete list and index &list=..........................&index=1
    .replace(/&list=[^&]+&index=\d+(&t=\d+s)?(&pp=\w+?)?$/, "")
    // for calibre, delete book pos
    .replace(/&bookpos=.*?&/, "&")
    // for leetcode, delete submissions
    .replace(/(?<=https:\/\/leetcode.com\/problems\/.*\/)submissions\/.*/, "");
  if (converted !== _url) {
    console.log("convert url", _url, "=>", converted);
  }
  return converted;
}

////////////////////////
// get main link list stealth from page flood
async function _openLinks(links) {
  // max 8 page on 1 origin once batch
  // max 16 page on all origin once batch
  const urlss = Object.values(Object.groupBy(links, (_url, i) => String(Math.floor(i / 8))));
  for await (const urls of urlss) {
    const urlList = urls.map((e) => e.href).join("\n");
    const confirmMsg = `confirm to open ${urls.length} pages?\n\n${urlList}`;
    if (!confirm(confirmMsg)) throw alert("cancelled by user");
    urls.toReversed().map(openDeduplicatedUrl);
    await new Promise((r) => setTimeout(r, 1e3)); // 1s cd
    await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true })); // wait for page visible
  }
  // await Promise.all(Object.entries(Object.groupBy(links, e => e.origin)).map(async ([origin, links]) => {
  //   const urls = links.map(e => e.href)
  //   const urlss = Object.values(Object.groupBy(urls, (url, i) => String(Math.floor(i / 8))))
  //   for await (const urls of urlss) {
  //     urls.toReversed().map(openUrl)
  //     await new Promise(r => setTimeout(r, 1e3)) // 1s cd
  //     await new Promise(r => document.addEventListener("visibilitychange", r, { once: true })) // wait for page visible
  //   }
  // }))
}

function openDeduplicatedUrl(url) {
  const opened = (globalThis.openDeduplicatedUrl_opened ??= new Set());
  return opened.has(url) || (window.open(url, "_blank") && opened.add(url));
}

function BagOfWordsModel() {
  const wordSet = new Set();
  return {
    wordSet,
    fit: (texts) => {
      texts.forEach(
        (text) =>
          void text
            .toLowerCase()
            .split(/\W+/)
            .forEach((word) => void wordSet.add(word)),
      );
    },
    transform: (text) => {
      const words = text.toLowerCase().split(/\W+/);
      const vec = Array.from(wordSet).map((word) => (words.includes(word) ? 1 : 0));
      return vec;
    },
  };
}

/**
 * Get the main list of anchor elements on the page by analyzing their features.
 * Uses a Bag of Words model on class names and attributes, along with geometric features.
 * Groups similar anchors by cosine similarity and ranks groups by area and count.
 * Highlights the top group of anchors on the page.
 * @returns {HTMLAnchorElement[]} - List of main anchor elements
 */
function getMainAnchorsList() {
  // groupBy words and then return map
  return (
    [{ sel: "a" }]
      .map((e) => ({ ...e, list: [...document.querySelectorAll(e.sel)] }))
      .map((e) => ({
        ...e,
        bow: BagOfWordsModel(),
      }))
      .map((e) => ({
        ...e,
        _: e.bow.fit(e.list.map((el) => `${el.className} ${getElementAttributeNames(el)}`)),
      }))
      .map((e) => ({
        ...e,
        vec: e.list.map((el, _i) => [
          elementDepth(el),
          area(el.parentElement?.getBoundingClientRect()),
          el.parentElement?.getBoundingClientRect().width,
          el.parentElement?.getBoundingClientRect().height,
          ...e.bow.transform(`${el.className} ${getElementAttributeNames(el)}`),
        ]),
      }))
      .map((e) => ({ ...e, nor: normalize(e.vec) }))
      .map((e) => ({ ...e, vecGrp: groupByCosineSimilarity(e.nor, 0.99) }))
      .map((e) => ({ ...e, grp: e.vecGrp.map((g) => g.map((i) => e.list[i])) }))
      .map((e) => ({
        ...e,
        rank: e.grp
          .map((g) => ({
            anchors: g,
            area: area(maxRect(g.map((el) => el.getBoundingClientRect()))),
            areaSum: g.map((el) => area(el.getBoundingClientRect())).reduce((a, b) => a + b, 0),
          }))
          .map((g) => ({ ...g, score: Math.log(g.area * g.areaSum) }))
          .toSorted(compareBy((g) => -g.score)),
      }))
      .map((e) => ({
        ...e,
        _: e.rank
          .slice(0, 1)
          .map((grp, i, a) =>
            grp.anchors.map((el) =>
              flashBorder(el, getOklch(i / a.length), 500 + (a.length - i) * 500),
            ),
          ),
      }))
      // debug
      .map((e) => ({ ...e }))
      .map((e) => e.rank.at(0).anchors)
      .at(0)
  );
}

function getOklch(t) {
  const l = 0.9 - 0.5 * t;
  const c = 0.2 + 0.3 * t;
  const h = 360 * t;
  return `oklch(${l} ${c} ${h})`;
}
function flashBorder(el, color, duration = 1000) {
  const orig = el.style.outline;
  el.style.outline = `3px solid ${color}`;
  return setTimeout(() => (el.style.outline = orig), duration);
}
function compareBy(fn) {
  return (a, b) => fn(a) - fn(b);
}
function maxRect(rects) {
  return {
    left: Math.min(...rects.map((e) => e.left)),
    top: Math.min(...rects.map((e) => e.top)),
    right: Math.max(...rects.map((e) => e.right)),
    bottom: Math.max(...rects.map((e) => e.bottom)),
  };
}
function area({ left, right, top, bottom }) {
  return (right - left) * (bottom - top);
}
function elementDepth(e) {
  return !e ? 0 : 1 + elementDepth(e.parentElement);
}
function normalize(arr) {
  const maxs = arr.reduce(
    (a, b) => a.map((e, i) => Math.max(e, b[i])),
    Array(arr[0].length).fill(-Infinity),
  );
  return arr.map((e) => e.map((v, i) => v / maxs[i]));
}
function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}
function magnitude(a) {
  return Math.sqrt(dot(a, a));
}
function cosineSimilarity(a, b) {
  return dot(a, b) / (magnitude(a) * magnitude(b));
}
function groupByCosineSimilarity(arr, threshold = 0.99) {
  const groups = [];
  const visited = new Set();
  arr.forEach((vec, i) => {
    if (visited.has(i)) return;
    const group = [i];
    visited.add(i);
    for (let j = i + 1; j < arr.length; j++) {
      if (cosineSimilarity(vec, arr[j]) > threshold) {
        group.push(j);
        visited.add(j);
      }
    }
    groups.push(group);
  });
  return groups;
}

function getElementAttributeNames(el) {
  if (!el) return "";
  const attrs = Array.from(el.attributes || [])
    .map((attr) => attr.name)
    .join(" ");
  return attrs;
}
