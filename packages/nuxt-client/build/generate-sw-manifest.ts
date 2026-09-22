import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** 预缓存清单文件名：Service Worker 在 install 阶段读取它 */
export const SW_MANIFEST_FILE = 'sw-manifest.json'
/** sw.js 里等待被替换成真实构建号的占位符 */
export const SW_BUILD_ID_PLACEHOLDER = '__BUILD_ID__'

/** 不预缓存的产物：体积大且只供调试，或是清单/脚本自身 */
function shouldSkip(name: string) {
  return name.endsWith('.map') || name === SW_MANIFEST_FILE || name === 'sw.js'
}

/**
 * 扫描构建产物目录，生成 Service Worker 的预缓存清单，并把构建号写进 sw.js。
 *
 * 在 Nitro 写完 .output/public 之后调用（见 nuxt.config.ts 的 hooks）。
 * 清单里全是构建产物：文件名带内容哈希（内容不变则文件名不变），可以放心 cache-first；
 * version 每次构建都不同，sw.js 据此换新缓存名，并在 activate 阶段清掉旧缓存，
 * 避免旧 HTML 引用已被删除的旧 chunk。
 */
export async function generateServiceWorkerManifest(publicDir: string) {
  const assets: string[] = []

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (shouldSkip(entry.name)) continue
      // Windows 下 join 出的是反斜杠，清单里必须是 URL 路径
      assets.push('/' + relative(publicDir, full).split(sep).join('/'))
    }
  }

  await walk(publicDir)
  assets.sort()

  const version = String(Date.now())
  await writeFile(
    join(publicDir, SW_MANIFEST_FILE),
    JSON.stringify({ version, assets }),
    'utf8'
  )

  // SW 脚本每次构建都带上新构建号：浏览器据此判定脚本有变化并触发更新，
  // 同时让 SW 在被浏览器回收重启后依然能拿到正确的缓存名（模块变量会丢，脚本常量不会）
  const swPath = join(publicDir, 'sw.js')
  try {
    const sw = await readFile(swPath, 'utf8')
    await writeFile(swPath, sw.replaceAll(SW_BUILD_ID_PLACEHOLDER, version), 'utf8')
  } catch {
    // sw.js 不存在（例如被裁剪过）不影响构建，只是不启用离线缓存
  }

  return { version, count: assets.length }
}
