# lyy_blog

油油的个人博客，记录在 AI 时代的所学所思所感。基于 [Astro 5](https://astro.build) 构建，部署在 GitHub Pages。

## 在线访问

https://lvyouyou.dev

## 内容分类

| 分类 | 内容 |
|------|------|
| **胡说八道** | 自己的一些想法，或者日常分享 |
| **架构分析** | 通过 AI 工具对一些代码仓库的分析 |
| **创业鬼才** | 脑子里的一些不切实际的想法，也许在 AI 时代真能变成现实 |

## UI 设计

界面设计借鉴了 [MotherDuck](https://motherduck.com/) 的设计语言：

- **配色**：暖米色（`#F4EFEA`）主背景 × 深炭色（`#383838`）边框与文字 × 亮黄（`#FFDE00`）交互高亮
- **字体**：[Fragment Mono](https://fonts.google.com/specimen/Fragment+Mono) 用于标题与 UI 元素，[Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) 用于正文
- **组件**：2px 实线边框、无模糊偏移阴影（sharp box-shadow）、卡片悬停时黄色闪光 + 位移上浮效果
- **CSS 方案**：[Tailwind CSS v4](https://tailwindcss.com)，通过 `@theme` 定义设计 token，零配置文件

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321
```

## 写文章

在 `src/content/blog/` 下新建 Markdown 文件：

```markdown
---
title: 文章标题
date: 2026-01-01
description: 文章摘要（可选）
category: 胡说八道   # 胡说八道 | 架构分析 | 创业鬼才
---

正文内容...
```

推送到 `main` 分支后，GitHub Actions 自动构建并部署，约 1~2 分钟生效。

## 技术栈

- [Astro 5](https://astro.build) — 静态站点生成，Content Collections 管理内容
- [Tailwind CSS v4](https://tailwindcss.com) — 样式方案，`@tailwindcss/vite` 集成
- [GitHub Pages](https://pages.github.com) — 静态托管，自定义域名 `lvyouyou.dev`
- [GitHub Actions](https://github.com/features/actions) — push to main 自动部署
