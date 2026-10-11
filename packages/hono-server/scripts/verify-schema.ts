import "dotenv/config"
import { is } from "drizzle-orm"
import { getTableConfig, PgTable } from "drizzle-orm/pg-core"
import postgres from "postgres"
import * as authSchema from "../src/db/auth-schema"
import * as schema from "../src/db/schema"

/**
 * 部署前的最后一道闸门：核对「代码声明的表 / 列」是否真的都存在于数据库里。
 *
 * 为什么必须有：`drizzle-kit push` **可能报错但仍然退出 0**。线上真实事故（2026-10-11）：
 * `user` 表要从 `couch_db_name` 改成 `timeline_db_name`，push 想确认"这是重命名吗"，
 * 于是走交互提示 —— 而容器里没有 TTY：
 *
 *   Error: Interactive prompts require a TTY terminal ... at promptColumnsConflicts
 *
 * 它打印了错误，进程却以 0 退出。compose 的 `service_completed_successfully` 只看退出码，
 * 于是迁移"成功"、server 带着**旧 schema** 启动，此后 Better Auth 查 user 行直接
 * `column "timeline_db_name" does not exist`（42703）→ 登录 500，且没人知道是迁移没跑。
 * 同一个提示还顺带卡住了 `user_timeline_settings` 建表。
 *
 * 所以：不能只信 push 的退出码，要在它之后**直接对着数据库断言一遍**。
 * 任何缺失都让本次部署失败（migrate 是非 0 退出，`server` 的
 * `depends_on: migrate: service_completed_successfully` 会拦住它），
 * 而不是把一个跑得起来但读不了数据的后端放上线。
 *
 * 只校验 public schema 里**我们自己声明**的表，不管多余的列与别的 schema
 * （Fedify 的 `fedify_*` 在独立 schema，见 drizzle.config.ts 的 tablesFilter）。
 */

/** drizzle 的 `pgTable()` 返回值在运行时的类型，用来从模块导出里挑出表 */
function isPgTable(value: unknown): value is PgTable {
  return is(value, PgTable)
}

function collectDeclaredTables(): Array<{ name: string, columns: string[] }> {
  const modules = [schema, authSchema]
  const tables: Array<{ name: string, columns: string[] }> = []
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (!isPgTable(value)) continue
      const config = getTableConfig(value)
      tables.push({ name: config.name, columns: config.columns.map(c => c.name) })
    }
  }
  // 同一个表被两个模块声明时只留一份；避免重复报告
  const byName = new Map(tables.map(t => [t.name, t]))
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("[verify-schema] 未设置 DATABASE_URL，无法校验")
    process.exit(1)
  }

  const declared = collectDeclaredTables()
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const rows = await sql<{ table_name: string, column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
    `
    const actual = new Map<string, Set<string>>()
    for (const row of rows) {
      const cols = actual.get(row.table_name) ?? new Set<string>()
      cols.add(row.column_name)
      actual.set(row.table_name, cols)
    }

    const missingTables: string[] = []
    const missingColumns: string[] = []
    for (const table of declared) {
      const cols = actual.get(table.name)
      if (!cols) {
        missingTables.push(table.name)
        continue
      }
      for (const column of table.columns) {
        if (!cols.has(column)) missingColumns.push(`${table.name}.${column}`)
      }
    }

    if (missingTables.length > 0 || missingColumns.length > 0) {
      console.error("\n[verify-schema] 数据库结构与代码声明不一致 —— 本次部署中止：")
      for (const t of missingTables) console.error(`  · 缺表：${t}`)
      for (const c of missingColumns) console.error(`  · 缺列：${c}`)
      console.error(
        "\n最常见的原因是 `drizzle-kit push` 撞上交互提示（例如重命名确认）后报错却退出 0。"
        + "\n先在本地看它要做什么：pnpm --filter @rssfed/hono-server exec drizzle-kit push --verbose"
        + "\n详见 docs/troubleshooting.md 的「migrate 容器退出码 0，但表/列根本没建出来」。\n",
      )
      process.exit(1)
    }

    console.log(`[verify-schema] OK：${declared.length} 张表、${declared.reduce((n, t) => n + t.columns.length, 0)} 个列与代码一致`)
  }
  finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error("[verify-schema] 校验本身失败：", err)
  process.exit(1)
})
