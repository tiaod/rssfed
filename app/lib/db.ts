import { drizzle } from 'drizzle-orm/node-postgres'

// 自动引入 schema 目录下所有 ts 文件
const schemaModules = import.meta.glob<Record<string, unknown>>('./schema/*.ts', { eager: true })

// 合并所有导出的表定义到 schema 对象
const schema = Object.values(schemaModules).reduce((acc, module) => {
  return { ...acc, ...module }
}, {} as Record<string, unknown>)

export const db = drizzle(process.env.DATABASE_URL!, { schema })
