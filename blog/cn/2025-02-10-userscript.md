---
title: "Lianki 用户脚本：基于 Tampermonkey 的浏览器集成"
date: 2025-02-10
tags: [用户脚本, tampermonkey, violentmonkey, 浏览器]
summary: "Lianki Tampermonkey 用户脚本的工作原理：悬浮按钮、内联复习对话框、URL 规范化与移动端适配。"
---

# Lianki 用户脚本：基于 Tampermonkey 的浏览器集成

Lianki 用户体验的核心是一个 Tampermonkey/Violentmonkey 用户脚本（`lianki.user.js`）。它在你访问的每个页面上显示一个悬浮按钮，一个快捷键把当前页面加入复习队列，复习在当前页面内联完成，无需离开。

## 安装

从以下地址安装：`https://www.lianki.com/lianki.user.js`

脚本运行于 `https://*/*`——每一个 HTTPS 页面。它在右下角注入一个可拖拽的悬浮操作按钮（FAB）。

## 悬浮按钮

FAB 在页面间持续存在，位置通过 `GM_setValue` 保存，下次打开仍在原处：

```javascript
GM_setValue("fabPosition", JSON.stringify({ x, y }));
// 加载时：
const pos = JSON.parse(GM_getValue("fabPosition", "{}"));
```

拖拽使用 `pointermove`/`pointerup` 事件。如果指针移动总距离不超过 5px，该事件视为点击（而非拖拽），避免拖拽时意外触发打开。

## 添加卡片

按 `Alt+F` 或点击 FAB 打开添加对话框，显示当前页面已规范化的 URL 和标题。提交后调用：

```
GET /api/fsrs/add?url=<规范化url>&title=<标题>
```

脚本使用 `GM_xmlhttpRequest` 而非 `fetch`。这是因为在移动端浏览器上，`fetch` 配合 `include` credentials 处理 `set-cookie` 响应头时行为不一致。`GM_xmlhttpRequest` 绕过页面的 CSP，始终正确携带 cookie。

```javascript
function gmFetch(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url,
      withCredentials: true,
      onload: resolve,
      onerror: reject,
    });
  });
}
```

## 复习对话框

当某张卡片到期且你正好在它的 URL 上时，FAB 会发光。点击后弹出复习对话框，显示四个按钮，每个按钮旁标注该评分对应的下次间隔：

```
Again  →  1天
Hard   →  3天
Good   →  8天
Easy   →  3周
```

复习时键盘快捷键同样有效：

- `1` / `D` / `L` — Again
- `2` / `W` / `K` — Hard
- `3` / `S` / `J` — Good
- `4` / `A` / `H` — Easy

快捷键同时覆盖 WASD 和 HJKL 布局，以及数字键 1–4，无论你习惯哪种操作方式都能用。

评分后，API 重定向到下一张到期卡片，或返回 `{"done": true}`。对话框显示成功消息并关闭，可选择自动跟随重定向。

## 对话框状态

对话框是一个简单的状态机：

| 状态        | 显示内容                     |
| ----------- | ---------------------------- |
| `idle`      | 无                           |
| `adding`    | 加载动画，"添加中…"          |
| `reviewing` | 四个评分按钮及到期时间       |
| `reviewed`  | "完成！"消息，倒计时自动关闭 |
| `error`     | 错误消息，附登录/重试链接    |

错误检测基于 JSON：如果 API 返回 `{"error": "not authenticated"}`，对话框显示登录链接，避免去解析 HTML 错误页面。

## URL 规范化

向服务器发送 URL 前，脚本会在客户端先行规范化：

```javascript
function normalizeUrl(raw) {
  const url = new URL(raw);

  // YouTube 短链
  if (url.hostname === "youtu.be") {
    return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  }

  // 移动版子域名
  if (/^m\./.test(url.hostname)) {
    url.hostname = "www." + url.hostname.slice(2);
  }

  // 去除追踪参数
  [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "ref",
    "_ga",
    /* 更多... */
  ].forEach((p) => url.searchParams.delete(p));

  return url.toString();
}
```

服务端在入库时执行同样的规范化。客户端也运行，意味着对话框中显示的 URL 已经是最终存储的规范形式，所见即所存。

## 移动端 App 劫持防护

部分移动端 App 会将自己注册为对应域名的 URL 处理程序。在 Android 上，在浏览器中打开 zhihu.com 链接会触发提示，询问是否在知乎 App 中打开。若 Lianki 自动导航到知乎 URL 进行复习，会用 App 打开提示强行劫持用户浏览器。

脚本内置了已知劫持域名黑名单：

```javascript
const APP_HIJACKING_DOMAINS = ["zhihu.com" /* ... */];

function wouldHijack(url) {
  const { hostname } = new URL(url);
  return APP_HIJACKING_DOMAINS.some((d) => hostname.endsWith(d));
}
```

来自这些域名的卡片仍可复习，但在移动端会抑制自动跳转行为。用户看到复习按钮，但不会被自动带到对应页面。

## 自动更新

脚本会自动检查更新。`lianki.com` 的每个 API 响应都包含 `x-lianki-version` 响应头。若版本与脚本当前版本不符，则弹出更新提示：

```javascript
const serverVersion = response.responseHeaders.match(/x-lianki-version: (.+)/)?.[1];
if (serverVersion && serverVersion !== GM_info.script.version) {
  showUpdateDialog(serverVersion);
}
```

这避免了依赖 Tampermonkey 内置更新检查计划的缓慢等待。

## 为什么选择用户脚本而非浏览器扩展

扩展需要在每个浏览器（Chrome Web Store、Firefox Add-ons 等）分别提交审核和发布。用户脚本可在所有支持 Tampermonkey 或 Violentmonkey 的浏览器上运行，涵盖 Chrome、Firefox、Safari（通过 Userscripts App）和 Edge。更新扩展需要经过审核队列，更新用户脚本只需把新文件推送到同一 URL——Tampermonkey 会自动检查更新。

代价是用户脚本要求用户已安装 Tampermonkey。对于目标用户群（开发者和高级用户）来说，这几乎不构成门槛。
