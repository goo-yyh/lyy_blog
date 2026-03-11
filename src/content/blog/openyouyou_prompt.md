---
title: openyouyou 实践的 prompt (一)
date: 2026-03-11
description: 持续更新ing
category: 胡说八道
---
## init
在当前目录下创建一个 tauri 2.0(https://v2.tauri.app/start/) 的客户端项目，叫做 youyoujiang，他需要遵循以下要求:
1. 整个界面的 UI 元素和设计 tokens，参考 https://motherduck.com/
2. 前端使用 react + zustand + shadcn/ui + tailwindcss，所有的依赖都使用最新版
3. 当 app 运行时，需要跟 claude 创建 .claude 目录一样，在电脑的 ～ 目录下检查是否存在 .youyou 文件夹，如果不存在，则创建一个，并且里面有这些内容
  a. skills 文件夹
  b. tools 文件夹
  c. plugins 文件夹
  d. prompt 文件夹
  e. AGENT.md
  f. SOUL.md

## agent 需求文档
我要在 ./src-tauri 下实现一个 agent 的模块，供 app 使用，请你按照我的要求出一个 agent 的具体的需求文档:
1. 参考 ../codex 中的多轮对话 agent 的实现，因为 codex 的代码是开源的，我们可以直接使用它的代码
2. 这个 agent 需要支持 codex 中的绝大多数功能，比如上下文存储、memories、会话持久化与发现、支持 plugins、支持 hooks，支持 skills，支持tools，还有支持多轮对话，支持 system prompt
3. 还有一些功能并不需要，比如 mcp、多agent、安全确认和审批、 沙箱
4. 这个 agent 是一个无状态的 agent，它内部不提供任何内置的 models、tools、skills、plugins、会话储存 等等，这些东西都有注册接口，全都是由外部实现并在初始化时候注册的，所以还需要设计一套注册规范

请你根据我的这些需求，仔细思考，看看还有没有遗漏的地方，如果有不清楚的可以继续追问我，需求文档输出在 ./specs/0001_youyou_demand.md 下

## 需求修改
先回答有关 open question 的问题
1. 不需要统计 token 计数
2. 也可以设置压缩模型，不设置的话默认使用对话模型
3. 这2个提取时机各有什么优缺点，memory 提取是用来做什么的。提取使用的模型可以设置，不设置的话默认使用对话模型/。
4. 请问你有没有什么好的方案
5. plugins 不是 skill 和 tool 的合集，而是为了配合 hooks 而设计的，每个 plugins 可以设置在每个 hook 阶段执行代码
6. 均可以被模型自由调用
7. 需要支持

然后我还有这些新的需求:
1. 在 main.rs 中有个方法 ensure_youyou_dir，是用来为 skills、tools 这些设置的文档，因此初始化的时候实际上就是阅读这些文档下的内容来注册，这些文档应该还不全，请你再帮我思考并且完善下，然后设计一个好的格式，来方便 agent 读取到这些信息
2. 前端页面中可以手动加载新的内容，比如 tools、skills 等等

我需要一个纯净的需求文档，中间先不要包含任何代码内容
请你根据我上面有关 open question 的回答，和新的需求，重新整理一份需求文档，输出在 ./specs/0002_youyou_demand.md 下，如果有什么问题，可以继续追问我，我们一起完成一篇完美的需求文档

## 问题澄清
Q3: 使用你的建议
Q4: 使用你的建议

新的问题:
1. 你有什么好的方案的，这个问题我还没有思考得特别清楚，可以先按你方案来
2. 共存的
3. 其实就是类似于 webpack 的 plugin 设计
4. 只影响新建的 session

还有什么新的问题吗

## 需求修改
1. 每次只能有一个 session 在运行中，不会存在多个 session 同时运行，在一个session处于运行中时不允许切换其他 session
2. .youyou 下面的目录中，每个 skill、tool 等外部注册内容，都应该是一个文件夹，文件下有个 index.md 做具体介绍，也可以有其他的参考文件在同一个目录下

请帮我按这两个需求优化 ./specs/0002_youyou_demand.md 的内容

## 需求review (to codex)
请你仔细 review 下 ./specs/0002_youyou_demand.md 中的需求设计，然后认真思考，进行屏摄功能。如果满分是 100 分，请你给这个需求设计文档打个分。
然后告诉我哪些没有考虑的点，或者哪些可以优化的点，把这个评审文档输出到 ./specs/0003_youyou_demand_review_by_codex.md 下

## 文档优化
请仔细阅读 /specs/0003_youyou_demand_review_by_codex.md 下的内容，做以下几点:
1. 如果它的建议是有效的，仔细思考，并且优化文档，如果有问题可以追问我
2. 如果它的建议是没有意义的，则不用理会

根据上面的要求，优化 ./specs/0002_youyou_demand.md