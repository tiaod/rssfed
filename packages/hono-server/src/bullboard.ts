import { createBullBoard } from "@bull-board/api"
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter"
import { HonoAdapter } from "@bull-board/hono"
import { serveStatic } from "@hono/node-server/serve-static"
import { fetchQueue } from "./workers"

// BullMQ 任务看板：http://localhost:3001/admin/queues
// 可查看各任务状态（等待/执行中/成功/失败）、任务数据与失败堆栈，并支持重试/清理
const serverAdapter = new HonoAdapter(serveStatic)

createBullBoard({
  queues: [new BullMQAdapter(fetchQueue)],
  serverAdapter,
})

serverAdapter.setBasePath("/admin/queues")

export const bullBoardApp = serverAdapter.registerPlugin()
