---
title: "FSRS 如何安排你的复习计划"
date: 2025-01-15
tags: [fsrs, 算法, 间隔重复]
summary: "FSRS 算法详解，以及 Lianki 如何用它来调度复习。"
---

# FSRS 如何安排你的复习计划

Lianki 使用 FSRS（自由间隔重复系统）来决定你何时复习每张卡片。本文介绍 FSRS 是什么、它与传统算法的区别，以及它在 Lianki 中的具体实现。

## 为什么不用 SM-2？

几十年来，间隔重复领域主流的算法是 SM-2，由 Piotr Wozniak 于 1987 年为 SuperMemo 开发，Anki 使用的是它的衍生版本。SM-2 的原理是为每张卡片维护一个"易度系数"，每次复习后将上一个间隔乘以该系数。

SM-2 有已知的问题：

- 易度系数可能持续走低，导致卡片堆积（俗称"ease hell"）
- 遗忘曲线建模不够准确——它假定所有人的遗忘速率相同
- 没有"可提取性"这一概念——即你现在有多大概率能想起某件事

FSRS 正是为解决这些问题而设计的。它由 Jarrett Ye 开发，基于 DSR（难度、稳定性、可提取性）记忆模型。

## 三个核心变量

FSRS 为每张卡片追踪三个量：

**难度（D）** — 这张卡片对你来说有多难。初始值由你第一次评分决定，随后根据持续表现缓慢更新。你始终觉得难的卡片难度值会升高。

**稳定性（S）** — 你能坚持多久不遗忘。评"Good"后稳定性提升，意味着下次间隔会更长；评"Again"后稳定性重置下降。

**可提取性（R）** — 你现在能回忆起这张卡片的概率，以百分比表示。它随时间按遗忘曲线衰减。FSRS 尽量在 R 降到约 90% 时安排复习——刚好在即将遗忘之前。

遗忘曲线公式：

```
R(t) = e^(-t / S)
```

其中 `t` 是已经过去的时间，`S` 是稳定性。稳定性越高，衰减越慢。

## 四种评分

在 Lianki 中复习一张卡片时：

| 评分 | 含义 | 效果 |
|------|------|------|
| Again（又忘了，1） | 忘记了 | 稳定性重置，卡片重回学习阶段 |
| Hard（有点难，2） | 勉强想起 | 稳定性小幅提升，间隔较短 |
| Good（还好，3） | 正确记起 | 稳定性正常提升 |
| Easy（太简单，4） | 轻而易举 | 稳定性大幅提升，间隔较长 |

下次复习时间的选取，使得届时可提取性约为 90%。

## Lianki 如何使用 ts-fsrs

Lianki 使用 [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) 库。以下是 `app/fsrs.ts` 中复习流程的核心代码：

```typescript
import { createEmptyCard, fsrs } from "ts-fsrs";

const f = fsrs();

// 向用户展示复习选项时：
const schedulingCards = f.repeat(card, now);

// schedulingCards 包含每种评分（Again/Hard/Good/Easy）对应的一条记录
// 每条记录有：card（更新后的状态）、log（复习记录）和到期时间
```

`repeat()` 一次性计算出所有四种可能的下一状态。Lianki 通过 `/api/fsrs/options` 接口把这些信息返回给用户，该接口返回每种评分对应的到期时间，UI 使用 `enhanced-ms` 库将其格式化为"2d 3h"这样的人类可读形式。

用户选择评分后，`/api/fsrs/review/:rating` 将选定的调度卡片写入 MongoDB：

```typescript
const { card, log } = schedulingCards[rating];
await collection.updateOne(
  { url },
  { $set: { card }, $push: { log } }
);
```

## 卡片状态

FSRS 卡片有四种状态：

```
New（新） → Learning（学习中） → Review（复习） → Relearning（重学）
                                     ↑                  ↓
                                     ←←←←←←←←←←←←←←←←←
```

- **New**：从未复习过
- **Learning**：刚引入，间隔短（分钟到天）
- **Review**：长期复习，间隔以天到月计
- **Relearning**：在 Review 阶段遗忘，重新进入短间隔

Lianki 的 UI 不直接显示这些状态——你只会看到到期日期，到时复习即可。

## 模糊因子

FSRS 默认对间隔加入小幅随机波动。如果没有模糊因子，同一天添加的 50 张卡片全部评"Good"后，会在完全相同的未来日期同时到期，造成复习"洪峰"。模糊因子会把它们略微打散。

## 日语内容优先

Lianki 的 `/api/fsrs/next` 路由有一个小启发：它检查到期卡片中是否有 URL 匹配日语/JLPT 内容的模式，并优先排列这些卡片。这是针对最初使用场景（日语学习）的手工调整，并非 FSRS 本身的功能。如果你不学日语，所有到期卡片都按到期时间顺序呈现。

## 默认参数

Lianki 使用 `ts-fsrs` 的默认 FSRS 参数。FSRS v5 支持根据复习历史对每个用户进行参数优化，但 Lianki 尚未实现这一功能，列在计划中。默认参数基于大量真实闪卡复习数据训练而来，对大多数人效果良好。
