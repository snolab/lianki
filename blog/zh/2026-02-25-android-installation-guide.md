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
4. 打开Firefox并完成初始设置

### 步骤2：安装用户脚本管理器

选择Tampermonkey或Violentmonkey之一：

#### 选项A：Violentmonkey（开源，轻量级）

1. 在Android上打开Firefox
2. 点击**菜单按钮**（三个点）→ **附加组件**
3. 搜索“**Violentmonkey**”
4. 点击**Violentmonkey** → **添加到Firefox**
5. 点击**添加**以确认安装

**直接链接**：[适用于Firefox Android的Violentmonkey](https://addons.mozilla.org/en-US/android/addon/violentmonkey/)

#### 选项B：Tampermonkey（功能丰富）

1. 在Android上打开Firefox
2. 点击**菜单按钮**（三个点）→ **附加组件**
3. 搜索“**Tampermonkey**”
4. 点击**Tampermonkey** → **添加到Firefox**
5. 点击**添加**以确认

**直接链接**：[适用于Firefox Android的Tampermonkey](https://addons.mozilla.org/en-US/android/addon/tampermonkey/)

**选择哪个？**
- **Violentmonkey**：[速度更快、开源、界面更简单](https://www.androidauthority.com/userscripts-android-firefox-violentmonkey-3610727/)
- **Tampermonkey**：[更多功能、云同步、更适合高级用户](https://www.ghacks.net/2023/02/19/firefox-for-android-adds-tampermonkey-support/)

### 步骤3：安装Lianki用户脚本

1. 在Firefox中访问：**https://www.lianki.com/lianki.user.js**
2. 您的用户脚本管理器会自动检测到脚本
3. 提示时点击**安装**
4. 确认安装

**✅ 成功！** Lianki现在已安装在Android上的Firefox上。

---

## 方法2：Kiwi浏览器

⚠️ **注意**：截至2025年，Kiwi浏览器已不再维护。建议使用Firefox以获得更好的可靠性。

### 步骤1：安装Kiwi浏览器

1. 打开**Google Play商店**
2. 搜索“**Kiwi浏览器**”
3. 安装**Kiwi Browser - Fast & Quiet**
4. 打开Kiwi浏览器

### 步骤2：启用开发者模式

Kiwi浏览器需要为扩展启用开发者模式：

1. 在Kiwi浏览器中，地址栏输入：`chrome://extensions/`
2. 点击**菜单**（右上角的三个点）
3. 启用**开发者模式**

### 步骤3：安装ViolentMonkey

1. 在Kiwi浏览器中访问：[Chrome网上应用店](https://chrome.google.com/webstore/category/extensions)
2. 搜索“**Violentmonkey**”
3. 点击**添加到Chrome**
4. 确认安装

**为什么不在Kiwi上使用Tampermonkey？**
[ViolentMonkey在Kiwi浏览器上效果更好](https://yunharla.wixsite.com/softwaremmm/post/user-scripting-in-browser-in-android)，而Tampermonkey存在兼容性问题。

### 步骤4：安装Lianki用户脚本

1. 访问：**https://www.lianki.com/lianki.user.js**
2. ViolentMonkey将提示您安装
3. 点击**确认安装**

---

## 安装Lianki用户脚本

无论浏览器/管理器组合如何：

### 安装步骤

1. **前往Lianki**：
   ```
   https://www.lianki.com/lianki.user.js
   ```

2. **自动检测**：
   - 您的用户脚本管理器会检测到脚本
   - 会出现一个弹出窗口要求安装

3. **查看权限**：
   - 脚本需要访问`*://*/*`（所有网站）以便从任何页面添加卡片
   - 连接到`lianki.com`，`www.lianki.com`，`beta.lianki.com`

4. **确认安装**：
   - 点击**安装**或**确认安装**
   - 等待确认信息

5. **验证安装**：
   - 打开您的用户脚本管理器
   - 检查“Lianki”是否已列出并启用

---

## 在Android上使用Lianki

### 添加您的第一张卡片

1. **浏览任何您想记住的网页**
2. 在浏览器中**点击菜单**（三个点）
3. **打开Lianki**：
   - Violentmonkey：点击扩展图标 → Lianki
   - Tampermonkey：点击扩展图标 → Lianki

   或使用快捷键：**Alt+F**（如果您的键盘支持）

4. **添加页面**：
   - 点击浮动的**Lianki按钮**（如果可见）
   - 或在地址栏中输入`javascript:`然后选择Lianki

5. **确认**：
   - 对话框会显示“添加笔记...”
   - 成功信息将出现

### 复习卡片

1. **访问Lianki仪表盘**：
   ```
   https://www.lianki.com/list
   ```

2. **开始复习**：
   - 点击“**下一张卡片**”按钮
   - 或访问：`https://www.lianki.com/next`

3. **触屏复习**：
   - 点击按钮：**再来一次** / **较难** / **良好** / **简单**

4. **键盘快捷键**（如果您有实体键盘）：
   - `H`或`4`：简单
   - `J`或`3`：良好
   - `L`或`1`：再来一次
   - `M`或`5`：删除
   - `Escape`：关闭对话框

### 移动设备友好提示

- **点击浮动按钮**：Lianki添加了一个浮动操作按钮以便于访问
- **使用横向模式**：更适合阅读长文章
- **启用深色模式**：更护眼（Firefox设置 → 主题）
- **固定Lianki标签页**：保持`/list`页面打开以便快速访问

---

## 故障排除

### 扩展未显示

**问题**：用户脚本管理器扩展不可见

**Firefox解决方案**：
1. 点击菜单（⋮）→ **附加组件**
2. 确认Tampermonkey/Violentmonkey已**启用**
3. 如有必要，重启Firefox

**Kiwi解决方案**：
1. 进入`chrome://extensions/`
2. 验证**开发者模式**已启用
3. 确认扩展已启用

### 脚本未运行

**问题**：Lianki未出现在页面上

**解决方案**：
1. 打开用户脚本管理器
2. 在脚本列表中找到“Lianki”
3. 确保它**已启用**（切换开关）
4. 检查脚本版本是否为最新（截至2026年2月为v2.19.3）
5. 尝试重新从https://www.lianki.com/lianki.user.js安装

### 浮动按钮不可见

**问题**：找不到页面上的Lianki按钮

**解决方案**：
1. 尝试滚动 - 按钮可能在折叠的下面
2. 使用Alt+F快捷键（如果可用）
3. 通过用户脚本管理器图标访问
4. 检查网站的CSS冲突（Shadow DOM应该可以防止这种情况）

### 登录问题

**问题**：无法登录Lianki

**解决方案**：
1. 清除浏览器缓存和Cookies
2. 尝试先在https://www.lianki.com登录
3. 使用电子邮件魔法链接而不是移动OAuth
4. 确保在浏览器设置中启用Cookies

### 同步不工作

**问题**：卡片不能在桌面和移动设备间同步

**解决方案**：
1. 确认您使用相同的帐户登录
2. 检查网络连接
3. 强制刷新移动设备：在`/list`页面下拉
4. 注销并重新登录

---

## 常见问题

### Lianki在Android上是否离线工作？

**部分支持**。登录后：
- ✅ 已安装的用户脚本离线工作
- ✅ 可以复习已加载的卡片
- ❌ 无法在没有网络的情况下同步新卡片
- ❌ 无法在没有网络的情况下添加新卡片

### 我可以在Android平板电脑上使用Lianki吗？

**当然可以！** 同样的安装过程适用于Android平板电脑。Firefox for Android在平板电脑上表现出色，屏幕更大。

### 哪个用户脚本管理器更适合Android？

**Violentmonkey**推荐给大多数用户：
- 轻量快速
- [开源且透明](https://www.androidauthority.com/userscripts-android-firefox-violentmonkey-3610727/)
- 在移动设备上效果良好
- 免费无限制

**Tampermonkey**更适合需要以下功能的人：
- 跨设备云同步
- 高级脚本管理功能
- 具备语法高亮的编辑器

### 我可以在Android上使用Chrome吗？

**不能。** Android版Google Chrome不支持扩展或用户脚本。您必须使用Firefox、Kiwi或其他具有扩展支持的基于Chromium的浏览器。

### 浮动按钮会影响网站吗？

Lianki浮动按钮使用**Shadow DOM**（自v2.19.2起）完全隔离于页面CSS。它不会影响网站功能，并在所有站点上保持一致外观。

### 如何在Android上更新Lianki脚本？

用户脚本管理器会自动检查更新：

**Violentmonkey**：
1. 点击扩展图标
2. 点击**仪表板**
3. 找到Lianki → 点击**⋮** → **检查更新**

**Tampermonkey**：
1. 点击扩展图标
2. 点击**仪表板**
3. 更新自动检查（可配置间隔）

或从https://www.lianki.com/lianki.user.js手动重新安装

### 我可以在Android上使用多个用户脚本吗？

**可以！** Tampermonkey和Violentmonkey都支持多个用户脚本。您可以将Lianki与其他脚本一起安装，例如：
- Dark Reader（网站深色模式）
- 绕过付费墙
- YouTube改进
- Reddit增强

### 在移动设备上使用用户脚本数据安全吗？

**是的**，遵循最佳实践时：
- ✅ 仅安装来自**可信来源**的脚本（如lianki.com）
- ✅ 安装前查看脚本权限
- ✅ 使用**开源**管理器（Violentmonkey）
- ✅ 保持脚本更新到最新版本
- ⚠️ 避免从未知站点安装随机脚本

Lianki是**开源**的，仅请求必要的权限：
- 访问所有网站（从任何页面添加卡片）
- 连接到lianki.com服务器（用于同步）

### Lianki会消耗Android设备的电池吗？

**影响很小**。这款用户脚本仅在以下情况下运行：
- 您主动浏览页面（用于浮动按钮）
- 您打开Lianki对话框时

当浏览器关闭时，它不会在后台运行。

---

## Android性能提示

### 优化Firefox以适应Lianki

1. **启用跟踪保护**：设置 → 隐私 → 标准/严格
2. **使用深色主题**：AMOLED屏幕省电
3. **限制打开的标签页**：关闭未使用的标签页以提高性能
4. **定期清除缓存**：设置 → 删除浏览数据

### 节省移动数据

1. **预加载卡片**：在WiFi上打开`/list`以缓存卡片
2. **离线复习**：卡片从缓存中快速加载
3. **禁用自动同步**：仅在需要时同步
4. **使用数据节省模式**：Firefox设置 → 数据节省

### 电池优化

1. **不复习时关闭Lianki对话框**
2. **不在后台保持`/next`页面**
3. **使用Firefox省电模式**
4. **在移动设备上禁用不必要的用户脚本**

---

## 下一步

现在您已在Android上安装了Lianki：

1. **登录**到您的账号：https://www.lianki.com
2. 从任何网页**添加第一张卡片**
3. 使用`/next`页面**每日复习**
4. **探索快捷键**以加快复习速度
5. **加入社区**获取提示和支持

### 相关指南

- [浏览器安装指南](./2025-02-22-browser-installation-guide.md) - 桌面浏览器设置
- [iOS安装指南](./2025-02-23-ios-installation-guide.md) - iPhone和iPad设置
- [FSRS算法](./2025-01-15-fsrs-algorithm.md) - 如何间隔重复工作

---

## 获取帮助

遇到问题？我们在这里帮助您：

- 🐛 **报告错误**：[GitHub Issues](https://github.com/snomiao/lianki/issues)
- 💬 **提出问题**：[GitHub Discussions](https://