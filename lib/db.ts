import { drizzle } from 'drizzle-orm/pglite';


// 初始化PGlite数据库
export const db = drizzle("local.db");
