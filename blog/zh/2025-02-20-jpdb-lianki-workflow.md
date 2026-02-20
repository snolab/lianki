---
title: "日语学习效率提升：结合 jpdb.io 与 Lianki 的完美工作流"
date: 2025-02-20
tags: [japanese, jpdb, workflow, vocabulary]
summary: "了解如何将 jpdb.io 词汇复习整合到 Lianki 间隔重复工作流中，实现更高效的日语学习。"
---

# 日语学习效率提升：结合 jpdb.io 与 Lianki 的完美工作流

如果你正在学习日语，你可能熟悉在词汇积累和沉浸式内容学习之间保持平衡的挑战。今天，我想分享一个强大的工作流，它结合了两个优秀的工具：用于词汇构建的 [jpdb.io](https://jpdb.io) 和用于学习材料间隔重复的 Lianki。

## 什么是 jpdb.io？

[jpdb.io](https://jpdb.io) 是一个综合性的日语学习平台，它将海量的原生内容数据库与智能间隔重复系统相结合。根据 [Tofugu 的评测](https://www.tofugu.com/japanese-learning-resources-database/jpdb-io/)，它正在迅速成为日语学习者的一站式平台。

### jpdb.io 的核心功能

**21,434+ 预制卡组**：包含 1,399 部动画、视觉小说、轻小说、网络小说及其他日语媒体的词汇。想看你最喜欢的动画？先学习它的词汇！

**1.3 亿+ 真实句子**：当你学习新词时，jpdb 会自动显示 **i+1 句子卡片** —— 除了你正在学习的新词外，其他词汇你都已经认识的例句。

**现代机器学习 SRS**：不是使用 1980 年代的旧 SM-2 算法，而是使用基于机器学习的方法，能更智能地处理遗忘和不规则复习。

**自定义汉字关键词**：类似于 Heisig 的《记忆汉字》，但为数千个汉字手动精选了更好的关键词。

## Lianki 提供什么？

Lianki 是一个围绕 [FSRS 算法](https://github.com/open-spaced-repetition/fsrs)构建的现代间隔重复系统 —— 与 Anki 最新版本使用的先进算法相同。这是 Lianki 对日语学习者的特别之处：

### 浏览器优先的工作流

**一键创建卡片**：安装 [Lianki 用户脚本](https://www.lianki.com/lianki.user.js)（Tampermonkey/Violentmonkey），在任何网页上按 `Alt+F` 即可将其添加为闪卡。使用 `Alt+Shift+V` 批量添加多个 URL。

**内联复习**：无需离开当前页面即可复习卡片。用户脚本直接在你正在阅读或观看的内容上叠加复习界面。

**键盘驱动**：使用 `1-4`（再来/困难/良好/简单）或 `HJKL`/`ASDT` 评分你的记忆。使用媒体键导航。无需鼠标。

### FSRS 算法

Lianki 使用 **DSR 模型**（难度、稳定性、可提取性）来比旧算法更准确地安排复习：

- **难度（Difficulty）**：这张卡片对你来说有多难
- **稳定性（Stability）**：你能记住多久才会遗忘
- **可提取性（Retrievability）**：你现在能回忆起来的概率（目标约为 90%）

卡片会在你即将遗忘时被安排复习 —— 在最大化记忆保持的同时最小化复习时间。

## 工作流：jpdb.io + Lianki

这是神奇的组合：**将 `https://jpdb.io/review` 添加为 Lianki 卡片。**

### 工作原理

1. **将 jpdb.io/review 添加到 Lianki**：
   - 访问 `https://jpdb.io/review`
   - 按 `Alt+F`（已安装 Lianki 用户脚本）
   - 你的 jpdb 复习页面现在是 Lianki 中的一张闪卡

2. **Lianki 使用 FSRS 安排 jpdb 复习**：
   - 无需每天手动检查 jpdb，Lianki 会基于最佳间隔重复时机提醒你
   - 完成 jpdb 复习时评为"良好"（按 `3`）
   - 如果跳过或有困难时评为"再来"（按 `1`）

3. **在循环学习材料时学习词汇**：
   - 你的 Lianki 队列可能看起来像这样：
     - 一集动画的 URL（今天到期）
     - `jpdb.io/review`（今天到期）
     - 一章漫画的 URL（明天到期）
     - 一个日语播客的 URL（3 天后到期）

4. **循环过程**：
   - 观看动画 → 在 Lianki 中复习它 → 去 jpdb 学习该动画的新词
   - 下次 Lianki 显示这个动画卡片时，你会认识更多词汇
   - 动画每循环一次就变得更容易

### 为什么这样有效

**情境中的词汇**：你从 jpdb 学习词汇，然后在 Lianki 中复习的内容里立即遇到它们。

**双重强化**：Lianki 间隔你的内容复习（动画、漫画、文章）。jpdb 间隔你的词汇复习。它们共同创造了一个强化循环。

**无摩擦集成**：因为 jpdb.io/review 只是你 Lianki 队列中的另一张卡片，你不需要在工具之间切换上下文或维护单独的学习计划。

**游戏化**：两个系统都使用 SRS，但 Lianki 的内联复习界面和键盘快捷键使复习*过程*感觉更流畅、更像游戏。

## 高级技巧

### 添加特定的 jpdb 卡组

除了 `jpdb.io/review`，你还可以将特定卡组 URL 添加为单独的卡片：

- `https://jpdb.io/anime/4072/revisions/vocabulary-list`（Revisions 动画）
- `https://jpdb.io/vocabulary-list/924/japanese-language-proficiency-test/2/n4/vocabulary-list`（JLPT N4）

这让你可以在 Lianki 安排时循环特定卡组，而不是跳入全局复习队列。

### 使用 Lianki 的批量添加功能添加整季动画

如果你正在看整季动画，一次性添加所有剧集 URL：

1. 复制所有剧集 URL（每行一个）
2. 按 `Alt+Shift+V`
3. Lianki 会为每集创建卡片
4. 当你观看并复习每集时，将对应的 jpdb 卡组添加为卡片

现在你的 SRS 计划将内容（剧集）与词汇（jpdb）交织在一起。

### 追踪你的进度

Lianki 在主页上显示 **GitHub 风格的活动热图**。你复习的每一天都会变成一个绿色方块。这种视觉反馈帮助你保持连续性并查看学习习惯的模式。

## 开始使用

1. **注册 jpdb.io**：基础功能免费（[Patreon](https://www.patreon.com/jpdb) 提供高级功能）
2. **安装 Lianki 用户脚本**：从 [lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js) 获取
3. **添加你的第一个 jpdb 卡组**：在 `https://jpdb.io/review` 上按 `Alt+F`
4. **添加一些内容**：浏览到动画剧集、漫画章节或日语文章，然后按 `Alt+F`
5. **开始复习**：访问 [lianki.com](https://www.lianki.com)，点击"下一张卡片"，按照复习流程进行

## 为什么不直接使用 Anki？

你完全可以使用 Anki！但 Lianki 为沉浸式学习者提供了一些优势：

- **基于 URL 的卡片**：专为网页内容（文章、视频、漫画阅读器）设计，而不是孤立的事实
- **浏览器集成**：无需复制/粘贴 —— 一个热键添加任何页面
- **轻量级**：无需安装桌面应用，通过用户脚本在任何地方工作
- **内容优先**：优化用于复习*材料*（教你词汇），而不是单个词汇

jpdb 处理词汇级别的训练。Lianki 处理内容级别的重复。它们共同覆盖两个方面。

## 结论

将 jpdb.io 的词汇系统与 Lianki 的基于内容的间隔重复相结合，创造了一个强大的日语学习工作流。你不只是孤立地记忆单词 —— 你在这些单词出现的真实内容中循环，并由 jpdb 的针对性词汇卡组强化。

试用一周。将 `jpdb.io/review` 添加到你的 Lianki 队列，加入一些动画剧集或漫画章节，看看这个循环如何加速你的学习。

快乐循环！練習がんばって！

---

**延伸阅读**：

- [jpdb.io 常见问题](https://jpdb.io/faq)
- [FSRS 如何安排你的复习](https://www.lianki.com/zh/blog/2025-01-15-fsrs-algorithm)（Lianki 博客）
- [Tofugu 的 jpdb.io 评测](https://www.tofugu.com/japanese-learning-resources-database/jpdb-io/)
