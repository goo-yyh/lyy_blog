---
title: 前端架构演进：从 jQuery 到 Islands
date: 2026-01-29
description: 二十年前端架构演进史，以及为什么 Islands 架构让我重新兴奋起来。
category: 架构分析
---

我入行时候 jQuery 还是主流，见证了前端架构这二十年的折腾。

## jQuery 时代：操作 DOM 的艺术

jQuery 解决了一个真实的痛点：跨浏览器兼容和 DOM 操作繁琐。那时候的前端架构很简单——HTML 描述结构，CSS 描述样式，JS 添加交互。职责清晰，但大型项目很快就会变成"意大利面条代码"。

## SPA 时代：前端变复杂了

React、Angular、Vue 带来了组件化和数据驱动的范式。这是巨大的进步，解决了 jQuery 时代的维护性问题。但代价是：**整个页面的渲染交给了 JavaScript**。

首屏性能问题随之而来。用户需要等待 JS 下载、解析、执行，才能看到内容。Core Web Vitals 里那些糟糕的 LCP 分数，很多就来自这里。

## SSR 的回归

服务端渲染本来就是 Web 的基础，但在 SPA 时代成了一种"高级技术"。Next.js、Nuxt 等框架把 SSR 带回了大众视野。

但 SSR + Hydration 有一个本质矛盾：服务端生成了 HTML，客户端还要再跑一遍 JS 来"激活"它，这个过程叫 Hydration，成本不低。

## Islands 架构：我目前最满意的答案

Islands 架构（Astro 的核心理念）把问题想清楚了：

**大多数页面内容是静态的，不需要 JS。只有少数"孤岛"（Island）需要交互。**

所以：默认输出静态 HTML，只在真正需要交互的组件上加载 JS。结果是极小的 JS bundle、极快的首屏、以及对 SEO 友好的 HTML。

这不是新技术，是回归常识——但用现代工具重新实现了它。
