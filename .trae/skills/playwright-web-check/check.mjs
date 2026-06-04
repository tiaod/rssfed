// Playwright 网页检查脚本
// 使用系统已安装的 Chrome 浏览器，无需额外下载
import { chromium } from 'playwright';
import process from 'process';

const TARGET_URL = process.env.CHECK_URL || 'http://localhost:3000';
// 使用系统 Chrome，避免下载浏览器
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const results = {
  consoleErrors: [],
  networkErrors: [],
  abortedRequests: [],
  pageErrors: [],
  pageCrashed: false,
  consoleWarnings: [],
  hasServiceWorker: false,
};

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME_PATH, // 使用系统 Chrome
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--enable-logging=stderr',
    '--v=1',
  ],
});

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

  // 监听 JS 运行时错误（如未捕获异常）
  page.on('pageerror', (error) => {
    results.pageErrors.push({
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
  });

  // 监听网络请求失败（包括 ERR_ABORTED）
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    results.networkErrors.push({
      url: request.url(),
      failure: failure?.errorText || 'unknown',
      method: request.method(),
      resourceType: request.resourceType(),
    });
  });

  // 额外捕获被中止的请求 - 通过拦截响应
  page.on('response', (response) => {
    if (response.status() >= 400) {
      results.abortedRequests.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });

  // 监听页面崩溃
  page.on('crash', () => {
    results.pageCrashed = true;
  });
});

// 页面加载后检查 Service Worker 状态
async function checkServiceWorker(page) {
  try {
    const swInfo = await page.evaluate(() => {
      if ('serviceWorker' in navigator) {
        return {
          supported: true,
          controlled: !!navigator.serviceWorker.controller,
        };
      }
      return { supported: false, controlled: false };
    });
    results.hasServiceWorker = swInfo.controlled;
    return swInfo;
  } catch {
    return { supported: false, controlled: false };
  }
}

const page = await context.newPage();

try {
  console.log(`正在访问: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 30000 });

  // 等待额外时间收集异步加载的日志
  await page.waitForTimeout(3000);

  // 获取页面标题
  const title = await page.title();
  console.log(`页面标题: ${title}`);

  // 检查 Service Worker 状态
  const swInfo = await checkServiceWorker(page);
  console.log(`Service Worker: ${swInfo.controlled ? '已激活' : '未激活'}`);

  // 检查页面是否被 SW 控制
  const swControlled = await page.evaluate(() =>
    'serviceWorker' in navigator ? navigator.serviceWorker.controller?.scriptURL || null : null
  );
  if (swControlled) {
    console.log(`SW 脚本地址: ${swControlled}`);
  }

} catch (error) {
  console.error('页面加载失败:', error.message);
  results.pageCrashed = true;
}

// 输出结果
console.log('\n========== Playwright 检查报告 ==========');
console.log(`页面标题: ${await page.title().catch(() => 'N/A')}`);

if (results.pageCrashed) {
  console.log('\n❌ 页面崩溃/加载失败');
}

if (results.pageErrors.length > 0) {
  console.log(`\n❌ 发现 ${results.pageErrors.length} 个 JS 运行时错误:`);
  results.pageErrors.forEach((err, i) => {
    console.log(`  ${i + 1}. ${err.message}`);
    if (err.stack) console.log(`     ${err.stack}`);
  });
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
} else {
  console.log('\n✅ 控制台无警告');
}

if (results.networkErrors.length > 0) {
  console.log(`\n❌ 发现 ${results.networkErrors.length} 个网络请求失败:`);
  results.networkErrors.forEach((err, i) => {
    console.log(`  ${i + 1}. ${err.method} ${err.url}`);
    console.log(`     失败原因: ${err.failure}`);
    console.log(`     资源类型: ${err.resourceType}`);
  });
} else {
  console.log('\n✅ 网络请求全部成功');
}

if (results.abortedRequests.length > 0) {
  console.log(`\n⚠️  发现 ${results.abortedRequests.length} 个异常状态请求:`);
  results.abortedRequests.forEach((req, i) => {
    console.log(`  ${i + 1}. ${req.method} ${req.url} (状态码: ${req.status})`);
  });
}

console.log(`\n📡 Service Worker: ${results.hasServiceWorker ? '已激活' : '未激活'}`);
console.log('\n========================================');

await browser.close();
