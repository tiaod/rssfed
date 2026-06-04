import { createApp, type ComponentPublicInstance } from 'vue'

/**
 * 为使用生命周期钩子或 inject 的 composable 创建宿主组件上下文。
 * 使用后在 afterEach 中调用 wrapper.unmount() 清理。
 */
export function withSetup<T>(composable: () => T): {
  result: T
  app: ReturnType<typeof createApp>
  root: ComponentPublicInstance
} {
  let result: T
  const app = createApp({
    setup() {
      result = composable()
      return () => null
    },
  })
  const root = app.mount(document.createElement('div'))
  return { result: result!, app, root }
}
