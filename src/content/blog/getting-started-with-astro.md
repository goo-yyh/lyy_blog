---
title: Astro 入门指南
date: 2026-02-20
description: 从零搭建 Astro 博客的关键概念与实践总结。
---

Astro 是一个以内容为中心的静态站点生成器，其核心理念是「默认零 JavaScript」——只在真正需要交互时才向浏览器发送脚本。

## 核心概念

### Islands 架构

Astro 采用 Islands 架构：页面主体是静态 HTML，交互组件（Island）按需激活。这让大多数博客页面的 JS 体积几乎为零。

### Content Collections

Content Collections 是 Astro 管理内容的最佳方式。通过 schema 定义 frontmatter 结构，获得完整的 TypeScript 类型支持：

```ts
// src/content.config.ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string().optional(),
  }),
});

export const collections = { blog };
```

### 文件路由

`src/pages/` 中的文件直接映射为路由，动态路由通过 `[slug].astro` + `getStaticPaths()` 实现。

## 部署到 GitHub Pages

1. 在 `astro.config.mjs` 设置 `site` 和 `base`
2. 添加 `.github/workflows/deploy.yml`
3. 在 GitHub 仓库设置中将 Pages source 改为 **GitHub Actions**

推送到 `main` 分支后，约 1~2 分钟即可看到更新。
