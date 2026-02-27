# lyy_blog

基于 [Astro 5](https://astro.build) 构建，部署在 GitHub Pages 的个人博客。

## 在线访问

https://goo-yyh.github.io/lyy_blog/

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321/lyy_blog/
```

## 写文章

在 `src/content/blog/` 下新建 Markdown 文件：

```markdown
---
title: 文章标题
date: 2026-01-01
description: 文章摘要（可选）
---

正文内容...
```

推送到 `main` 分支后，GitHub Actions 自动构建并部署，约 1~2 分钟生效。

## 技术栈

- [Astro 5](https://astro.build) — 静态站点生成
- [GitHub Pages](https://pages.github.com) — 托管
- [GitHub Actions](https://github.com/features/actions) — CI/CD
