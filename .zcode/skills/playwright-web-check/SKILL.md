---
name: "playwright-web-check"
description: "使用 Playwright 检查正在开发的网页是否存在控制台错误、网络请求失败、页面崩溃/白屏等问题，并可运行 Lighthouse 审计。Invoke when the user asks to check the web page for errors or issues during development."
---

# Playwright Web Check

使用 Playwright 自动化检查正在开发的网页是否存在问题。

## 适用场景

- 用户说"帮我看网页有没有报错"
- 用户说"检查页面有没有问题"
- 用户要求对当前开发的网页进行质量检查
- 用户想要运行 Lighthouse 审计

## 前置条件

确保 Playwright 已安装。如未安装，先执行安装：

```bash
# 安装 Playwright
pnpm add -D playwright @playwright/test

# 安装浏览器（chromium 即可）
npx playwright install chromium
```

## 检查流程

### 1. 启动开发服务器（如未运行）

确保项目的开发服务器正在运行。根据项目类型启动：

```bash
pnpm dev:all        # 本项目，并行运行所有子包
pnpm dev:nuxt       # 仅前端 Nuxt 应用
pnpm dev            # 仅服务端
```

### 2. 执行检查脚本

检查脚本位于 `.trae/skills/playwright-web-check/check.mjs`，它使用系统 Chrome 浏览器（无需额外下载浏览器）：

```bash
# 默认检查 localhost:3000
node .trae/skills/playwright-web-check/check.mjs

# 也可指定其他地址
CHECK_URL=http://localhost:5173 node .trae/skills/playwright-web-check/check.mjs
```

该脚本会检查以下项目：
- 页面是否能正常加载
- 控制台错误和警告
- JS 运行时错误（未捕获异常）
- 网络请求失败
- 异常状态码响应（4xx/5xx）
- Service Worker 状态

### 3. 运行 Lighthouse 审计（可选）

Lighthouse 审计需要额外的 `lighthouse` 包，如需使用请先安装：

```bash
pnpm add -D lighthouse
```

然后在 `.trae/skills/playwright-web-check/` 目录下创建 `lighthouse.mjs` 文件：

```javascript
import { chromium } from 'playwright';
import { play } from 'lighthouse';
import fs from 'fs';

const TARGET_URL = process.env.CHECK_URL || 'http://localhost:3000';

const browser = await chromium.launch({ headless: true });
const port = new URL(browser.wsEndpoint()).port;

const { report } = await play(TARGET_URL, {
  port: Number(port),
  output: 'html',
  onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
});

fs.writeFileSync('lighthouse-report.html', report);
console.log('Lighthouse 报告已生成: lighthouse-report.html');

await browser.close();
```

运行方式：

```bash
node .trae/skills/playwright-web-check/lighthouse.mjs
```

### 4. 报告解读

检查完成后，向用户呈现结果摘要：

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 页面加载 | ✅/❌ | 页面是否能正常加载 |
| 控制台错误 | ✅/❌ | JS 运行时错误数量 |
| 控制台警告 | ✅/⚠️ | 不影响的警告信息 |
| 网络请求 | ✅/❌ | 资源加载失败数量 |
| Lighthouse | 分数 | 性能/可访问性等指标 |

## 注意事项

1. 开发服务器要先启动，检查脚本才能正常工作
2. 如果页面需要登录，先告知用户登录信息或调整脚本绕过认证
3. 脚本运行完毕后，可询问用户是否需要保留脚本或删除
4. 对于 SSR 应用，Playwright 能捕获客户端渲染后的错误
