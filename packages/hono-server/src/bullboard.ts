import { createBullBoard } from "@bull-board/api"
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter"
import { HonoAdapter } from "@bull-board/hono"
import { serveStatic } from "@hono/node-server/serve-static"
import { fetchQueue } from "./workers"

// BullMQ 任务看板：http://localhost:3001/admin/queues
// 可查看各任务状态（等待/执行中/成功/失败）、任务数据与失败堆栈，并支持重试/清理
//
// Bull Board 是「注册谁显示谁」：项目里每个 `new Queue(...)` 都要在这里挂一个 adapter，
// 否则该队列在 Redis 里有数据、任务也在跑，看板左侧列表里却看不到它。
//
// 现在只剩**一个**队列：抓取（一个 job = 一个 owner 的一个源）。旧模型的
// `rss-timeline`（拓扑对齐）、`rss-timeline-sync`（单源搬运）、`rss-bot-copy`（Bot 产物复制）
// 都随共享源库一起删掉了 —— 新模型里抓取直接写 owner 自己的库，没有搬运这一步。
const serverAdapter = new HonoAdapter(serveStatic)

createBullBoard({
  queues: [
    new BullMQAdapter(fetchQueue),
  ],
  serverAdapter,
})

serverAdapter.setBasePath("/admin/queues")

export const bullBoardApp = serverAdapter.registerPlugin()
