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

### 2. 编写 Playwright 检查脚本

在项目根目录创建临时脚本（用完可删除），内容如下：

```javascript
// .trae/skills/playwright-web-check/check.mjs
import { chromium } from 'playwright';

const TARGET_URL = process.env.CHECK_URL || 'http://localhost:3000';

const results = {
  consoleErrors: [],
  networkErrors: [],
  pageCrashed: false,
  consoleWarnings: [],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
});

// 收集控制台消息
context.on('page', (page) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push({
        text: msg.text(),
        location: msg.location(),
      });
    } else if (msg.type() === 'warning') {
      results.consoleWarnings.push({
        text: msg.text(),
        location: msg.location(),
      });
    }
  });

  // 监听网络请求失败
  page.on('requestfailed', (request) => {
    results.networkErrors.push({
      url: request.url(),
      failure: request.failure()?.errorText,
      method: request.method(),
    });
  });

  // 监听页面崩溃
  page.on('crash', () => {
    results.pageCrashed = true;
  });
});

const page = await context.newPage();

try {
  console.log(`正在访问: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // 等待额外时间收集异步加载的日志
  await page.waitForTimeout(3000);

  // 如果有交互（如登录），可以在此处添加操作
  // 例如：await page.click('button');
  // 然后再次等待收集日志

} catch (error) {
  console.error('页面加载失败:', error.message);
  results.pageCrashed = true;
}

// 输出结果
console.log('\n========== Playwright 检查报告 ==========');

if (results.pageCrashed) {
  console.log('\n❌ 页面崩溃/加载失败');
}

if (results.consoleErrors.length > 0) {
  console.log(`\n❌ 发现 ${results.consoleErrors.length} 个控制台错误:`);
  results.consoleErrors.forEach((err, i) => {
    console.log(`  ${i + 1}. ${err.text}`);
    if (err.location?.url) {
      console.log(`     位置: ${err.location.url}:${err.location.lineNumber}:${err.location.columnNumber}`);
    }
  });
} else {
  console.log('\n✅ 控制台无错误');
}

if (results.consoleWarnings.length > 0) {
  console.log(`\n⚠️  发现 ${results.consoleWarnings.length} 个控制台警告:`);
  results.consoleWarnings.forEach((warn, i) => {
    console.log(`  ${i + 1}. ${warn.text}`);
  });
}

if (results.networkErrors.length > 0) {
  console.log(`\n❌ 发现 ${results.networkErrors.length} 个网络请求失败:`);
  results.networkErrors.forEach((err, i) => {
    console.log(`  ${i + 1}. ${err.method} ${err.url} - ${err.failure}`);
  });
} else {
  console.log('\n✅ 网络请求全部成功');
}

console.log('\n========================================');

await browser.close();
```

### 3. 执行检查

```bash
# 默认检查 localhost:3000
node .trae/skills/playwright-web-check/check.mjs

# 也可指定其他地址
CHECK_URL=http://localhost:5173 node .trae/skills/playwright-web-check/check.mjs
```

### 4. 运行 Lighthouse 审计（可选）

如果需要运行 Lighthouse 审计：

```javascript
// .trae/skills/playwright-web-check/lighthouse.mjs
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

> 注意：Lighthouse 需要额外安装 `lighthouse` 包：`pnpm add -D lighthouse`

### 5. 报告解读

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
