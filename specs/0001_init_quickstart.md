# 0001 Astro + GitHub Pages 博客快速启动方案

## 目标

搭建一个可以部署到 GitHub Pages 的最小可用 Astro 博客，支持写 Markdown 文章、本地预览和自动部署。

---

## 技术选型

| 项目 | 选择 | 说明 |
|------|------|------|
| 框架 | Astro 4.x | 静态优先，原生支持 Markdown |
| 部署平台 | GitHub Pages | 免费，与 GitHub 仓库深度集成 |
| CI/CD | GitHub Actions | 官方推荐的 Astro 部署方式 |
| 包管理器 | npm | 默认，无额外依赖 |

---

## 目录结构

```
my-blog/
├── .github/
│   └── workflows/
│       └── deploy.yml        # 自动部署工作流
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro  # 全局 HTML 骨架
│   │   └── PostLayout.astro  # 文章页布局
│   ├── pages/
│   │   ├── index.astro       # 首页（文章列表）
│   │   └── posts/
│   │       └── hello-world.md  # 示例文章
│   └── styles/
│       └── global.css        # 全局样式
├── public/
│   └── favicon.svg
├── astro.config.mjs
└── package.json
```

---

## 实现步骤

### 第一步：创建 Astro 项目

```bash
npm create astro@latest my-blog
# 选择：Empty（空模板）
# 选择：不安装依赖（手动执行）
cd my-blog
npm install
```

### 第二步：配置 astro.config.mjs

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://<your-github-username>.github.io',
  base: '/<your-repo-name>',   // 如果仓库名不是 username.github.io，则需要此项
});
```

> **注意**：如果仓库名为 `<username>.github.io`，则删除 `base` 字段。

### 第三步：创建布局文件

**`src/layouts/BaseLayout.astro`**

```astro
---
const { title } = Astro.props;
---
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
    <link rel="stylesheet" href="/styles/global.css" />
  </head>
  <body>
    <header>
      <a href="/">我的博客</a>
    </header>
    <main>
      <slot />
    </main>
  </body>
</html>
```

**`src/layouts/PostLayout.astro`**

```astro
---
import BaseLayout from './BaseLayout.astro';
const { frontmatter } = Astro.props;
---
<BaseLayout title={frontmatter.title}>
  <h1>{frontmatter.title}</h1>
  <time>{frontmatter.date}</time>
  <slot />
</BaseLayout>
```

### 第四步：创建首页

**`src/pages/index.astro`**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';

const posts = await Astro.glob('./posts/*.md');
const sorted = posts.sort(
  (a, b) => new Date(b.frontmatter.date) - new Date(a.frontmatter.date)
);
---
<BaseLayout title="我的博客">
  <h1>文章列表</h1>
  <ul>
    {sorted.map(post => (
      <li>
        <a href={post.url}>{post.frontmatter.title}</a>
        <span>{post.frontmatter.date}</span>
      </li>
    ))}
  </ul>
</BaseLayout>
```

### 第五步：创建示例文章

**`src/pages/posts/hello-world.md`**

```markdown
---
layout: ../../layouts/PostLayout.astro
title: Hello World
date: 2026-02-27
---

这是我的第一篇博客文章。
```

### 第六步：配置 GitHub Actions

**`.github/workflows/deploy.yml`**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

### 第七步：在 GitHub 启用 Pages

1. 进入仓库 → **Settings** → **Pages**
2. Source 选择 **GitHub Actions**
3. 保存

---

## 本地开发

```bash
npm run dev      # 启动开发服务器 http://localhost:4321
npm run build    # 构建到 ./dist
npm run preview  # 本地预览构建产物
```

---

## 部署流程

```
本地写文章 → git commit → git push main → GitHub Actions 触发 → 构建 → 部署到 Pages
```

整个流程约 1–2 分钟完成。

---

## 最小 package.json 参考

```json
{
  "name": "my-blog",
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "astro": "^4.0.0"
  }
}
```

---

## 后续扩展（超出本文范围）

- RSS Feed：`@astrojs/rss`
- Sitemap：`@astrojs/sitemap`
- 代码高亮：Astro 内置 Shiki，无需额外配置
- 自定义域名：在仓库根目录添加 `CNAME` 文件
- 标签 / 分类：通过 frontmatter 字段 + 动态路由实现
