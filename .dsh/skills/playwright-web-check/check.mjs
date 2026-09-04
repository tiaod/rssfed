#!/usr/bin/env node
/**
 * Playwright 网页检查脚本（增强版）
 *
 * 相对旧版的改进：
 *  1. 不再写死 /usr/bin/google-chrome，改为跨平台自动探测浏览器，
 *     找不到时回退到 Playwright 自带 Chromium。
 *  2. 新增整页截图，输出不再是纯文本，更直观。
 *  3. 修正 4xx/5xx 响应统计逻辑。
 *
 * 用法：
 *   node check.mjs                        # 默认 http://localhost:3000
 *   CHECK_URL=http://localhost:5173 node check.mjs
 *   OUT_DIR=/tmp/webreport node check.mjs
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const TARGET_URL = process.env.CHECK_URL || 'http://localhost:3000';
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'report');
const EXPLICIT_CHROME = process.env.CHROME_PATH || '';

// ---------------------------------------------------------------
// 跨平台浏览器探测
// ---------------------------------------------------------------
function guessBrowserExecutable() {
  const platform = os.platform();
  const home = os.homedir();
  const candidates = [];
  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(home, 'AppData','Local','Google','Chrome','Application','chrome.exe'),
      path.join(home, 'AppData','Local','Microsoft','Edge','Application','msedge.exe')
    );
  }
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications','Google Chrome.app','Contents','MacOS','Google Chrome')
    );
  }
  if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/local/bin/google-chrome',
      '/opt/google/chrome/chrome',
      path.join(home, '.local/bin/chromium'),
      path.join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'),
      path.join(home, '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
      '/snap/bin/chromium'
    );
  }
  for (const c of candidates) {
    if (c) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  }
  return null;
}

function detectBrowser() {
  if (EXPLICIT_CHROME && fs.existsSync(EXPLICIT_CHROME)) {
    return { opt: { executablePath: EXPLICIT_CHROME }, label: '系统浏览器(CHROME_PATH): ' + EXPLICIT_CHROME };
  }
  const g = guessBrowserExecutable();
  if (g) return { opt: { executablePath: g }, label: '系统浏览器: ' + g };
  return { opt: {}, label: 'Playwright 自带 Chromium' };
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------
const R = { consoleErrors:[], consoleWarnings:[], pageErrors:[],
  networkFailures:[], badStatus:[], crashed:false, swControlled:false };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { opt, label } = detectBrowser();
  console.log('使用的浏览器:', label);

  let browser;
  try {
    browser = await chromium.launch(Object.assign({ headless:true,
      args:['--no-sandbox','--disable-setuid-sandbox'] }, opt));
  } catch (err) {
    console.error('[x] 无法启动浏览器: ' + err.message);
    console.error('    若本机没有系统浏览器，请先运行:  pnpm dlx playwright install chromium');
    process.exitCode = 1;
    return;
  }

  const context = await browser.newContext({ viewport:{ width:1440, height:900 }, ignoreHTTPSErrors:true });

  context.on('page', (page) => {
    page.on('console', (msg) => {
      const loc = msg.location() || {};
      const e = { text: msg.text(), url: loc.url, line: loc.lineNumber, col: loc.columnNumber };
      if (msg.type() === 'error') R.consoleErrors.push(e);
      else if (msg.type() === 'warning') R.consoleWarnings.push(e);
    });
    page.on('pageerror', (error) => {
      R.pageErrors.push({ message: error.message, stack: (error.stack || '').split('\n').slice(0,4).join('\n') });
    });
    page.on('requestfailed', (req) => {
      const f = req.failure();
      R.networkFailures.push({ url: req.url(), method: req.method(), type: req.resourceType(), reason: (f && f.errorText) || 'unknown' });
    });
    page.on('response', (resp) => { if (resp.status() >= 400) {
      R.badStatus.push({ url: resp.url(), status: resp.status() }); } });
    page.on('crash', () => { R.crashed = true; });
  });

  const page = await context.newPage();
  let title = 'N/A';
  try {
    console.log('正在访问:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil:'load', timeout:35000 });
    await page.waitForTimeout(3500);
    title = (await page.title().catch(() => '')) || '(无标题)';
    console.log('页面标题:', title);
    const sw = await page.evaluate(() => ('serviceWorker' in navigator) ? { supported:true, controlled:!!navigator.serviceWorker.controller } : { supported:false, controlled:false });
    R.swControlled = sw.controlled;
    try {
      const shot = path.join(OUT_DIR, 'page.png');
      await page.screenshot({ path: shot, fullPage: true });
      console.log('整页截图已保存:', shot);
    } catch (e) { console.log('截图失败:', e.message); }
  } catch (error) {
    console.error('页面加载失败:', error.message);
    R.crashed = true;
  }

  console.log('');
  console.log('========== Playwright 检查报告 ==========');
  console.log('目标:', TARGET_URL);
  console.log('页面标题:', title);
  console.log('浏览器:', label);
  if (R.crashed) console.log('[x] 页面崩溃/加载失败');
  if (R.pageErrors.length) {
    console.log('[x] JS 运行时错误 x' + R.pageErrors.length);
    R.pageErrors.forEach((e,i)=>console.log('  '+(i+1)+'. '+e.message));
  }
  if (R.consoleErrors.length) {
    console.log('[x] 控制台错误 x' + R.consoleErrors.length);
    R.consoleErrors.slice(0,20).forEach((e,i)=>console.log('  '+(i+1)+'. '+e.text+(e.url?('  @'+e.url+':'+e.line):'')));
    if (R.consoleErrors.length>20) console.log('  ... 还有 '+(R.consoleErrors.length-20)+' 条');
  } else console.log('[ok] 控制台无错误');
  if (R.networkFailures.length) {
    console.log('[x] 网络请求失败 x' + R.networkFailures.length);
    R.networkFailures.slice(0,20).forEach((e,i)=>console.log('  '+(i+1)+'. '+e.method+' '+e.url+'  ['+e.type+'/'+e.reason+']'));
    if (R.networkFailures.length>20) console.log('  ... 还有 '+(R.networkFailures.length-20)+' 条');
  } else console.log('[ok] 网络请求全部成功');
  if (R.badStatus.length) {
    console.log('[!] 非 2xx 状态码 x' + R.badStatus.length);
    R.badStatus.slice(0,20).forEach((e,i)=>console.log('  '+(i+1)+'. ['+e.status+'] '+e.url));
  }
  if (R.consoleWarnings.length) {
    console.log('[!] 控制台警告 x'+R.consoleWarnings.length+'（首个）: '+R.consoleWarnings[0].text);
  }
  console.log('[+] Service Worker: ' + (R.swControlled ? '已激活' : '未激活'));
  console.log('[+] 产物目录: ' + OUT_DIR + '（含 page.png 整页截图）');
  console.log('==========================================');
  await browser.close();
}

main().catch((err)=>{ console.error('脚本异常:', err); process.exitCode = 1; });
