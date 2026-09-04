---
name: "playwright-web-check"
description: "Playwright 检查正在开发的网页是否有控制台错误、网络请求失败、崩溃/白屏，并可跑 Lighthouse。Dev 阶段用户要求检查网页问题时使用。"
---

# Playwright Web Check

用 Playwright 自动检查开发中的网页问题，并保存整页截图。

## 适用场景

- 用户说“帮我看网页有没有报错”
- “检查页面有没有问题”
- 对开发中网页做质量检查
- 运行 Lighthouse 审计
- 需要拿到当前页面的渲染截图

## 一次性准备（首次）

本机通常没有固定的 /usr/bin/google-chrome，且环境多样，故提供一键准备脚本，会安装 playwright 并下载自带 Chromium：

  bash .dsh/skills/playwright-web-check/setup.sh

也可手动：

  pnpm add -Dw playwright
  pnpm exec playwright install chromium

## 运行检查

先启动开发服务器（前端默认 http://localhost:3000）：pnpm dev:all / pnpm dev:nuxt

  node .dsh/skills/playwright-web-check/check.mjs
  CHECK_URL=http://localhost:5173 node .dsh/skills/playwright-web-check/check.mjs
  CHROME_PATH=/path/to/chrome node .dsh/skills/playwright-web-check/check.mjs
  OUT_DIR=/tmp/webreport node .dsh/skills/playwright-web-check/check.mjs

脚本自动探测系统浏览器(Linux/macOS/Windows)，找不到则回退 Playwright 自带 Chromium。

## 检查内容

- 页面是否正常加载（标题/崩溃）
- 控制台错误和警告
- JS 运行时错误（未捕获异常）
- 网络请求失败（含原因与资源类型）
- 非 2xx 状态码响应（4xx/5xx）
- Service Worker 状态
- 整页截图 report/page.png

## Lighthouse（可选）

  pnpm add -Dw lighthouse
  npx lighthouse http://localhost:3000 --output-path=./lighthouse-report.html --view

## 报告解读

脚本输出带标记 ([ok]/[x]/[!]) 的报告，连同 report/page.png 交由 Agent 定位问题。

| 检查项 | 标记 | 说明 |
|--------|------|------|
| 页面加载 | [x] | 崩溃或加载失败 |
| 控制台错误 | [x] | JS 运行时/控制台错误数 |
| 控制台警告 | [!] | 通常不影响运行 |
| 网络请求 | [x] | 失败数与原因 |
| 状态码 | [!] | 4xx/5xx 响应 |
| 截图 | [+] | report/page.png |

## 注意事项

1. 开发服务器要先启动，否则显示加载失败。
2. 需登录的页面先处理认证或用 CHECK_URL 指向已登录会话。
3. 默认产物在 ./report；可用 OUT_DIR 调整。
4. 本技能在 `.dsh/skills/` 下为唯一来源（DSH 项目级技能目录）。