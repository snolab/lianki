---
title: "Lianki 的部署：Vercel + GitHub Actions"
date: 2025-02-15
tags: [部署, vercel, github-actions, ci-cd]
summary: "Lianki CI/CD 流水线的工作原理：两个分支、两套环境，以及一个简洁的 GitHub Actions 工作流。"
---

# Lianki 的部署：Vercel + GitHub Actions

Lianki 运行在 Vercel 上，采用双分支策略：`main` 对应生产环境，`beta` 对应预览环境。部署由 GitHub Actions 触发，而非 Vercel 内置的 Git 集成，这样对构建过程有更多控制权。

## 分支策略

| 分支 | URL | 用途 |
|------|-----|------|
| `main` | https://www.lianki.com | 生产环境 |
| `beta` | https://beta.lianki.com | 预发布 / 预览 |

功能开发在特性分支进行，合并到 `beta` 测试，再合并到 `main` 发布。旧域名 `fsrsnext.snomiao.com` 发送 308 重定向到 `www.lianki.com`，为已有链接保留可访问性。

## GitHub Actions 工作流

部署工作流位于 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Vercel

on:
  push:
    branches: [main, beta]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 安装 Vercel CLI
        run: npm install -g vercel@latest

      - name: 拉取 Vercel 环境配置
        run: vercel pull --yes --environment=${{ github.ref_name == 'main' && 'production' || 'preview' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: 构建
        run: vercel build ${{ github.ref_name == 'main' && '--prod' || '' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: 部署
        run: vercel deploy --prebuilt ${{ github.ref_name == 'main' && '--prod' || '' }} --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

`github.ref_name == 'main' && '--prod' || ''` 这个三元表达式使 `main` 推送生产部署，`beta` 推送预览部署。需要三个 GitHub Secret：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

## 为什么用自定义 Actions 而非 Vercel 的 Git 集成

Vercel 内置的 GitHub 集成对简单项目很好用，但有一个局限：它在 Vercel 的基础设施上运行构建，无法介入 CI 流程。改用 GitHub Actions 的好处：

- 构建前的检查（lint、类型检查）在同一流水线中、构建之前运行
- `vercel pull` 步骤从 Vercel 的密钥库拉取环境变量，无需在 GitHub 中重复维护 Secret
- 构建日志集中在 GitHub Actions，不必在 GitHub 和 Vercel 两处分别查看

## Vercel 项目配置

Vercel 项目名为 `lianki`。关键 ID：

```
Project ID: prj_BoWb5ZrwLrYVyAxGb8a5XOs7i7gu
Org ID:     team_0YVgkyqvak5X8lMl3zNBqIC7
```

DNS 通过 Cloudflare 管理（`lia.ns.cloudflare.com`、`roan.ns.cloudflare.com`）。Cloudflare 位于 Vercel 前面，作为 `lianki.com` 的反向代理。

## 预提交钩子

每次提交都会经过 Husky：

```sh
# .husky/pre-commit
bun fix   # oxlint --fix + oxfmt
bunx @typescript/native-preview --noEmit
```

`bun fix` 运行 `oxlint`（代码检查）和 `oxfmt`（格式化）。`tsgo --noEmit` 是来自 `@typescript/native-preview` 的 TypeScript 类型检查器，对大型代码库比 `tsc` 快得多。

`packages/` 目录被排除在 lint 和 format 之外——它包含一个 git 子模块（`pardon-could-you-say-it-again`），修改其中的文件会污染子模块状态。

## 环境变量

Vercel 为两套环境分别存储环境变量。CI 中的 `vercel pull` 步骤拉取对应环境（生产或预览）的配置并写入 `.vercel/output/`，不需要在 GitHub Actions Secret 中重复维护。

唯一需要存储在 GitHub 中的 Secret 是 Vercel 凭证本身（`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`）。

本地开发使用 `.env.local` 文件（不提交到 git）：

```env
MONGODB_URI=mongodb://localhost:27017/lianki
AUTH_SECRET=dev-secret-change-me
EMAIL_SERVER=smtp://localhost:1025
EMAIL_FROM=dev@localhost
```

## .vercelignore

`.vercelignore` 文件用于减小部署包体积：

```
packages/
*.test.ts
*.spec.ts
```

`packages/` 子模块不需要部署——其代码在构建时被导入并打包进输出产物中。

## Claude Code Action

仓库还有一个用于 Claude Code 的 GitHub Actions 工作流（`.github/workflows/claude.yml`）。在任意 Issue 或 PR 评论中提及 `@claude`，就会触发 Claude 响应、读取代码库并提出或应用修改。该功能使用 `anthropics/claude-code-action@beta`，`ANTHROPIC_API_KEY` 以 GitHub Secret 形式存储。
