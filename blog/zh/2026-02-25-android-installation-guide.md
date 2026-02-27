---
title: "如何在Android上使用Lianki：完整安装指南"
description: "逐步教程，教您如何在Android手机和平板电脑上用Firefox、Kiwi浏览器或其他支持的浏览器安装和使用Lianki用户脚本"
date: 2026-02-25
author: Lianki团队
tags: ["安卓", "移动设备", "安装", "用户脚本", "tampermonkey", "violentmonkey", "firefox", "教程"]
---

# 如何在Android上使用Lianki：完整安装指南

想在您的Android手机或平板电脑上使用Lianki的间隔重复系统吗？本综合指南将向您展示如何在Android设备上安装和使用Lianki用户脚本。

## 内容目录

- [为什么在Android上使用Lianki？](#为什么在android上使用lianki)
- [支持的浏览器](#支持的浏览器)
- [方法1：Firefox for Android（推荐）](#方法1firefox-for-android推荐)
- [方法2：Kiwi浏览器](#方法2kiwi浏览器)
- [安装Lianki用户脚本](#安装lianki用户脚本)
- [在Android上使用Lianki](#在android上使用lianki)
- [故障排除](#故障排除)
- [常见问题](#常见问题)

## 为什么在Android上使用Lianki？

在您的Android设备上使用Lianki有几个优点：

- 📱 **随时随地学习**：在通勤、休息或闲暇时复习闪卡
- 🔄 **无缝同步**：您的卡片在所有设备（桌面、移动、平板）间同步
- 🚀 **快速复习**：在浏览网页时从移动浏览器添加卡片
- 🎯 **保持一致性**：通过移动访问永远不会错过复习环节

## 支持的浏览器

2026年支持用户脚本管理器的Android浏览器：

| 浏览器 | 用户脚本管理器 | 状态 | 推荐 |
|---------|-------------------|--------|----------------|
| **Firefox for Android** | Tampermonkey, Violentmonkey | ✅ 完全支持 | **推荐** |
| **Kiwi浏览器** | Violentmonkey（旧版） | ⚠️ 限制支持 | 替代方案 |
| **Yandex浏览器** | Tampermonkey | ⚠️ 限制 | 不推荐 |

### 为什么推荐Firefox

[Firefox for Android](https://www.mozilla.org/firefox/browsers/mobile/android/)是最可靠的选择，因为：

- ✅ **官方扩展支持**：对[Tampermonkey](https://addons.mozilla.org/en-US/android/addon/tampermonkey/)和[Violentmonkey](https://addons.mozilla.org/en-US/android/addon/violentmonkey/)的原生支持
- ✅ **积极维护**：Mozilla定期更新
- ✅ **无需变通方法**：扩展可开箱即用
- ✅ **更好的隐私**：开源且注重隐私
- ✅ **稳定性能**：可靠的用户脚本执行

### Kiwi浏览器的考虑

[Kiwi浏览器](https://kiwibrowser.com/)因支持Chrome扩展而受欢迎，但也有限制：

- ⚠️ **已停用**：自2025年1月以来[官方不再维护](https://www.quetta.net/blog/the-best-alternatives-to-kiwi-browser)
- ⚠️ **需要变通方法**：Tampermonkey需要开发者模式
- ⚠️ **最佳搭配ViolentMonkey**：[Kiwi推荐的扩展](https://yunharla.wixsite.com/softwaremmm/post/user-scripting-in-browser-in-android)

---

## 方法1：Firefox for Android（推荐）

### 步骤1：安装Firefox for Android

1. 打开Android设备上的**Google Play商店**
2. 搜索“**Firefox浏览器**”
3. 安装**Firefox浏览器**（由Mozilla提供）
4. 打