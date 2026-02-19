---
title: "Lianki 的技术架构：Next.js 16 + MongoDB"
date: 2025-02-01
tags: [架构, nextjs, mongodb, typescript]
summary: "Lianki 的技术栈、数据模型和关键设计决策详解。"
---

# Lianki 的技术架构：Next.js 16 + MongoDB

本文介绍 Lianki 的构建方式：技术选型、数据模型、API 设计，以及一些在实践中被证明有效的实现模式。

## 技术栈概览

| 层次 | 技术 |
|------|------|
| 框架 | Next.js 16（App Router） |
| 语言 | TypeScript 5 |
| 运行时 | Node.js 20 / Bun |
| 数据库 | MongoDB |
| 认证 | NextAuth.js v5 |
| 样式 | Tailwind CSS |
| 包管理器 | Bun |
| 部署 | Vercel |

选择 Next.js 16 App Router，是因为它将前端和 API 整合进一个项目，Vercel 部署零摩擦，React Server Components 减少了以读为主的 UI 的客户端包体积。

选择 MongoDB 而非关系型数据库，是因为核心文档——FSRS 卡片——是一个嵌套层次丰富的对象，且随着 FSRS 算法演进其结构可能变化。强行塞进固定 Schema 意味着频繁迁移。MongoDB 可以按原样存储卡片对象。

## 数据模型

每个用户的卡片存储在名为 `FSRSNotes@{邮箱}` 的 MongoDB 集合中。采用每用户独立集合而非共享集合加 userId 字段的方案，查询更简单（无需 `userId` 过滤），数据隔离也更显式。

单条文档结构如下：

```typescript
type FSRSNote = {
  url: string;           // 规范化 URL——唯一键
  title?: string;        // 保存时的页面标题
  card: Card;            // 完整的 FSRS 卡片状态
  log?: CardLogItem[];   // 复习历史（每次复习时追加）
};
```

`Card` 类型直接来自 `ts-fsrs`，包含：`due`、`stability`、`difficulty`、`elapsed_days`、`scheduled_days`、`reps`、`lapses`、`state`、`last_review`。

卡片数据没有单独的用户表——身份通过推导集合名称的邮箱确定。NextAuth 相关集合（`users`、`accounts`、`sessions`、`verificationTokens`）由 `@auth/mongodb-adapter` 管理，存储在同一 MongoDB 数据库中。

## URL 规范化

卡片入库前，URL 会经过规范化处理：

```typescript
function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  // YouTube 短链：youtu.be/ID → youtube.com/watch?v=ID
  if (url.hostname === "youtu.be") {
    return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  }

  // 移动版子域名：m.example.com → www.example.com
  if (url.hostname.startsWith("m.")) {
    url.hostname = "www." + url.hostname.slice(2);
  }

  // 去除追踪参数
  const trackingParams = ["utm_source", "utm_medium", "utm_campaign",
    "utm_content", "utm_term", "fbclid", "gclid", "ref", ...];
  trackingParams.forEach(p => url.searchParams.delete(p));

  return url.toString();
}
```

服务端（`/api/fsrs/add`）和客户端（用户脚本）都会执行这一规范化。结果是：同一内容不会意外产生重复卡片。

## API 路由

所有卡片操作都在 `/api/fsrs/` 下：

```
GET  /api/fsrs/add?url=...&title=...   添加卡片
GET  /api/fsrs/options?id=...          获取复习选项（显示每种评分的到期时间）
GET  /api/fsrs/review/:rating?id=...   提交复习评分
GET  /api/fsrs/next-url               获取下一张到期卡片的 URL
GET  /api/fsrs/delete?id=...          删除卡片
GET  /api/fsrs/next                   重定向到下一张到期卡片的复习页
GET  /api/fsrs/all                    打开所有到期卡片
GET  /api/fsrs/                       列出所有到期卡片
```

大多数路由即使对于修改操作也使用 GET。这是务实的选择——用户脚本和基于浏览器的流程中，GET 更易处理（无需 CORS 预检，可收藏书签）。不符合 REST 纯粹主义，但管用。

认证通过 NextAuth 的 `auth()` 辅助函数在每个路由上检查。未认证请求返回 401。

## 使用 sflow 流式处理

卡片查询使用 `sflow` 库进行流式处理，而非一次性将所有文档加载到内存：

```typescript
import { sflow } from "sflow";

const notes = await sflow(
  collection.find({ "card.due": { $lte: now } }).sort({ "card.due": 1 })
)
  .take(50)
  .toArray();
```

`sflow` 将 MongoDB 游标包装为异步可迭代管道。对于卡片量大的用户，这避免了为了显示前 10 张到期卡片而加载数千条文档。

## 认证配置

NextAuth v5 在 `auth.ts` 中配置了三个提供商：

```typescript
export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(clientPromise),
  session: { strategy: "jwt" },
  providers: [
    Nodemailer({ server: process.env.EMAIL_SERVER, from: process.env.EMAIL_FROM }),
    GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET }),
    Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      return session;
    },
  },
});
```

GitHub 和 Google 是条件启用的——如果相应的环境变量未设置，提供商就不会注册。这让本地开发更方便：只需邮箱认证和本地 MongoDB 即可运行。

## 工具链选择

**Bun** 用作包管理器和运行时。安装速度远快于 npm/yarn，且内置 TypeScript 支持，无需 ts-node 来执行脚本。

**oxlint** 负责代码检查。比 ESLint 快，能捕获真正重要的问题（未使用变量、错误的 hook 用法等），无需庞大的插件生态。`packages/` 目录（git 子模块）通过 `--ignore-pattern 'packages/**'` 排除在外。

**oxfmt** 负责代码格式化。这是一款兼容 Prettier 的快速格式化工具。每次提交前的钩子会运行 `bun fix`（检查 + 格式化）和 `tsgo --noEmit`（通过 `@typescript/native-preview` 进行 TypeScript 类型检查）。

## 环境变量

最少需要以下变量才能运行：

```env
MONGODB_URI=mongodb+srv://...
AUTH_SECRET=<随机字符串>
```

添加邮箱认证：

```env
EMAIL_SERVER=smtp://user:pass@host:port
EMAIL_FROM=noreply@yourdomain.com
```

添加 OAuth：

```env
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
```

Google OAuth 凭证在 `fsrsnext.snomiao.com`（旧域名）和 `lianki.com` 之间共享。两个回调 URL 都需要在 Google Cloud Console 中注册。
