import { createBullBoard } from "@bull-board/api"
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter"
import { HonoAdapter } from "@bull-board/hono"
import { serveStatic } from "@hono/node-server/serve-static"
import { fetchQueue } from "./workers"
import { timelineQueue } from "./workers/timeline"
import { sourceSyncQueue } from "./workers/timeline-sync"
import { botCopyQueue } from "./workers/bot-sync"

// BullMQ 任务看板：http://localhost:3001/admin/queues
// 可查看各任务状态（等待/执行中/成功/失败）、任务数据与失败堆栈，并支持重试/清理
//
// Bull Board 是「注册谁显示谁」：项目里每个 `new Queue(...)` 都要在这里挂一个 adapter，
// 否则该队列在 Redis 里有数据、任务也在跑，看板左侧列表里却看不到它（曾漏掉后三个队列）。
// 顺序按数据流：抓取 → 用户拓扑对齐 → 单源搬运 → Bot 产出复制。
const serverAdapter = new HonoAdapter(serveStatic)

createBullBoard({
  queues: [
    new BullMQAdapter(fetchQueue),
    new BullMQAdapter(timelineQueue),
    new BullMQAdapter(sourceSyncQueue),
    new BullMQAdapter(botCopyQueue),
  ],
  serverAdapter,
})

serverAdapter.setBasePath("/admin/queues")

export const bullBoardApp = serverAdapter.registerPlugin()
