/**
 * 主侧边栏的开合状态。
 *
 * 原先它是布局里的一个 ref，只有布局自己能关。但侧边栏底部是用户菜单，从那里能打开设置弹窗；
 * 窄屏下弹窗会盖在抽屉上，而点击弹窗里的「订阅管理」要跳页 —— 如果只是布局内部的事，
 * 弹窗那边就够不着，抽屉会一直停在展开状态（同址跳转时路由也不会替我们关）。
 *
 * 状态放 useState：入口与消费方不在同一棵组件树上（同 useSettingsModal / useEntryModal）。
 * 宽屏下 `open` 不生效（竖栏由 lg:flex 常驻），关掉它对宽屏没有副作用。
 */
export function useAppSidebar() {
  const isOpen = useState<boolean>('app-sidebar-open', () => false)

  function close(): void {
    isOpen.value = false
  }

  return { isOpen, close }
}
