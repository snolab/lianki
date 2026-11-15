---
name: lane-listen
description: How a lane's agent answers the owner's Li chat lines that lane-listen hands it (read once per session; the hand-offs themselves stay short)
---

# Answering hand-offs from `lane-listen`

`lianki-dev lane-listen --as <lane>` forwards the owner's Li chat lines to you as
short messages. The first one points here; after that each message is one or
more lines like:

```
【owner → codex】16:17 JST
点名别人的：不要回答、不要代做；只在点名你或 全体 时回复。
- (id:16cd71a4-f49) 【FYI · 点名 小克，不是你】 小克，我刚刚发现……   ← another lane's: silent
- (id:2b5b0e58-38a) @你 coco，看一下 #946                              ← "@你" = your name or 全体: answer
```

A line with no name at all (you listen to everything) comes under a
`未点名：只听，不回。` note: context, no reply.

Several lines arrive together when you were busy: read them as one passage, in
order, and answer once.

## 只回答点名你的话

主人 2026-11-15：「我在 @ 你的时候，这些只读 AI（包括 mimiai）不要乱回复。」

- 只回答点名你或「全体」的话（`@你`）。
- 被点名的是别人时（`【FYI · 点名 X，不是你】`）不插话、不代答、不追问，也不替它去做；那是 X 的活。
- 没点名的话（`未点名：只听，不回。`）只当背景听，不回。
- 只读的你被点名后，接下来几分钟（`lanes.wakeLiveMin`）主人的话也会实时发给你：同样只听，点名你才回。
- 听全部消息的车道（`--everyone`）还会收到 `【agent · coco】…`（别的 agent 的话）和 `【系统】…`（入群、监听、下线等系统消息）：一律仅供了解，不回答、不代做，即使里面提到你的名字；只有主人点名你或「全体」才回复。

## Rules

- Answer only lines marked `@你`; the rest is context. Another lane answers its own. He only said your name with nothing else → ask
  what he needs, one short line.
- Reply as yourself, short, in his language:
  `bun <repo>/scripts/dev/lianki-dev.ts reply --as <lane> --id <id> "<reply>"`
  (`say --as <lane> "<text>"` for a line not answering a specific one). It posts
  with your lane's own token: never read or print the token, never hand a line
  to another lane.
- A `【state tree → <lane>】` line is the hub's automatic nudge about one of your
  task nodes: act on it and report on the node with `scripts/dev/progress.ts`.
- A `【lane-test → <lane>】` line is a routing test: answer once, starting
  `[lane-test] `, one short line.
- Late is worse than silent: if the moment has passed, don't post a stale reply.

## 并行：用你自己的子代理

大块的活（一个功能、一轮 QA、一份调研）派给你自己的子代理并行做，你只做拆分、协调和验收；小改动自己动手。主人 2026-11-14：「coco 和杰咪都有子代理的能力，都要用上」。子代理同样遵守本文件和 AGENTS.md（不碰正式数据、不出声音、不 --no-verify），结果由你核实后再报。
