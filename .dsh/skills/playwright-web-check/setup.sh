#!/usr/bin/env bash
# 一键准备脚本：为 playwright-web-check skill 安装依赖并下载浏览器
# 用法:   bash setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT"

echo "==> 检测包管理器 (pnpm 优先)..."
PKG=pnpm
if command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
elif command -v npm >/dev/null 2>&1; then
  PKG=npm
else
  echo "错误: 未找到 pnpm 或 npm"; exit 1
fi
echo "    使用: $PKG"

echo "==> 安装 Playwright (devDependency)..."
if [ "$PKG" = pnpm ]; then
  pnpm add -Dw playwright
else
  npm install --save-dev playwright
fi

echo "==> 下载 Chromium 浏览器..."
if [ "$PKG" = pnpm ]; then
  pnpm dlx playwright install chromium
  pnpm exec playwright install chromium || true
else
  npx playwright install chromium
fi

echo ''
echo '✅ 准备完成!'
echo '下一步，在已启动 dev 服务器(=3000)的情况下运行:'
echo '    node '$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)'/check.mjs'
echo '或以绝对路径运行:'
echo '    CHECK_URL=http://localhost:3000 node '"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'/check.mjs'
