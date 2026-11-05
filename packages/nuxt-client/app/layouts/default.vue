<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { useUserStore } from '~/stores/user'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import EntryReaderPane from '~/components/EntryReaderPane.vue'
import AppIcon from '~/components/AppIcon.vue'

const userStore = useUserStore()

// 侧边栏搜索框：目前只占位，未接入任何搜索逻辑（后续做搜索时在这里接线）
const sidebarSearch = ref('')

/**
 * 视口过矮（手机横屏、超矮窗口）时把侧边栏退回「整体滚动」。
 *
 * 固定头部（logo + 搜索框 + 主导航 + 「订阅源」标题行 + 用户区）约占 350px，
 * 低于 600px 时留给订阅源列表的空间不足 250px，硬固定会把列表压成一条缝，
 * 此时让整块内容一起滚更好用。SSR 与客户端首帧都按 false 渲染（固定布局），
 * 挂载后再按真实高度切换，避免 hydration mismatch。
 */
const compactSidebar = ref(false)
function syncCompactSidebar() {
  compactSidebar.value = window.innerHeight < 600
}

// 正常：body 不滚动，只让订阅源列表内部滚动；紧凑：用主题默认的 overflow-y-auto 整块滚动。
// 间距一律用主题默认值（gap-4），不再自定义收紧
//
// footer 不再画 border-t（主题默认没有，这里也不再额外加）：用户区与订阅源列表之间
// 改用列表底部的渐隐过渡（见 FeedNavigation 的 showFade），参考 DeepSeek 侧边栏。
const sidebarUi = computed(() => ({
  body: compactSidebar.value ? undefined : 'flex-1 min-h-0 overflow-hidden'
}))

// 初始化用户 session — 在客户端挂载后刷新，确保登录/登出后状态正确
onMounted(async () => {
  syncCompactSidebar()
  window.addEventListener('resize', syncCompactSidebar)
  await userStore.refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncCompactSidebar)
})

const open = ref(false)
// 通知入口暂时下线，恢复底部通知按钮时一并取消注释
// const notificationsOpen = ref(false)

/**
 * 宽屏 + 「列表」视图：详情改由右侧的常驻阅读栏承载，弹窗整块不挂载。
 *
 * 阅读栏放在这里（面板的同级一栏）而不是页面的面板里面：它是一整栏，自己的顶栏要和页面导航栏
 * 并排、各自占满自己的列；塞进面板 body 的话页面导航栏会横跨整行盖在它上面。
 *
 * 两个展示面互斥而不是「弹窗留在 DOM 里但隐藏」：打开即已读、全文懒取、浏览器返回键都挂在
 * 展示面上，同时挂载会让同一篇被处理两次（尤其是历史栈会多压一条）。
 */
const readerPane = useReaderPaneMode()

const navItems = computed<NavigationMenuItem[]>(() => {
  const items: NavigationMenuItem[] = [
    {
      label: '主页',
      icon: 'i-lucide-rabbit',
      to: '/',
      onSelect: () => { open.value = false }
    },
    {
      label: '时间线',
      icon: 'i-lucide-activity',
      to: '/timeline',
      onSelect: () => { open.value = false }
    },
    {
      label: 'Bot 广场',
      icon: 'i-lucide-bot',
      to: '/bots/explore',
      onSelect: () => { open.value = false }
    },
    {
      label: '收藏',
      icon: 'i-lucide-star',
      to: '/saved',
      onSelect: () => { open.value = false }
    },
    {
      label: '最近阅读',
      icon: 'i-lucide-history',
      to: '/history',
      onSelect: () => { open.value = false }
    },
    {
      label: '我的',
      icon: 'i-lucide-user',
      to: '/profile',
      onSelect: () => { open.value = false }
    }
  ]

  return items
})

/**
 * 移动端底部导航（lg 以下）：侧边栏在这里收成抽屉，主导航入口需要多点一次才够得着，
 * 所以把三个高频入口钉在屏幕底部。只做这三项，其余入口仍走抽屉。
 */
const mobileNavItems = computed<NavigationMenuItem[]>(() => [
  {
    label: '首页',
    icon: 'i-lucide-house',
    to: '/'
  },
  {
    label: '时间线',
    icon: 'i-lucide-activity',
    to: '/timeline'
  },
  {
    label: '机器人',
    icon: 'i-lucide-bot',
    to: '/bots/explore'
  }
])

/**
 * 底栏：图标与文字左右排、三格等分。
 * 水平导航默认是横向 `flex items-center` 的 pill 列表，这里只做合并覆盖：
 * 列表铺满整行、每项 flex-1 平分，并用 link variant 去掉 pill 的选中底色——
 * 底栏选中态靠主色图标与文字区分，整块底色太重。横排因此只需 2.5rem 高。
 * 图标取 size-4、文字 text-sm：40px 高的横排里比 size-3/text-xs 更饱满、留白更少。
 * 注意组件内部把列表包在一个无类名的 div 里（nav > div > ul），只给 ul 设
 * w-full 没用——外层 div 没有宽度、会按内容收缩，所以由根节点把子 div 也撑满。
 */
const mobileNavUi = {
  root: 'h-full w-full [&>div]:w-full',
  list: 'flex w-full h-full',
  item: 'flex-1 min-w-0 h-full list-none',
  link: 'flex-row justify-center gap-1 h-full px-1 py-0',
  linkLeadingIcon: 'size-4',
  linkLabel: 'text-sm'
}
</script>

<template>
  <!-- 移动端底部留出底栏高度（2.5rem + 安全区），面板内容因此止于底栏上沿而不被盖住；
       与下面 UNavigationMenu 的高度必须成对改。lg 以上没有底栏，恢复原样 -->
  <UDashboardGroup
    unit="rem"
    class="pb-[calc(2.5rem_+_env(safe-area-inset-bottom))] lg:pb-0"
  >
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      :ui="sidebarUi"
    >
      <template #header="{ collapsed }">
        <!-- 折叠后只剩 4rem（min-w-16 + 两侧 px-4），只放得下 Logo：
             悬停时 Logo 淡出、展开按钮在同一位置淡入（参考 DeepSeek 侧边栏）。
             ghost + neutral 默认是 text-default，比导航图标的 text-muted 深，这里覆盖成同一档浅灰 -->
        <div
          v-if="collapsed"
          class="group relative mx-auto size-8 shrink-0"
        >
          <AppIcon class="absolute inset-0 size-8 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" />
          <UTooltip text="打开侧边栏">
            <UDashboardSidebarCollapse
              class="absolute inset-0 text-muted opacity-0 transition-opacity hover:text-default group-hover:opacity-100 focus-visible:opacity-100"
            />
          </UTooltip>
        </div>
        <template v-else>
          <!-- Logo 宽度受限渲染（默认 SVG 宽高比约 5:1，高度随之缩放），因此加宽比单纯加高更见效 -->
          <AppLogo class="w-36 h-10" />
          <!-- 收起按钮自带 hidden lg:flex：只在桌面侧边栏出现，移动端抽屉用自带的 toggle -->
          <UDashboardSidebarCollapse class="ms-auto text-muted hover:text-default" />
        </template>
      </template>

      <template #default="{ collapsed }">
        <!-- 搜索框占位：紧贴 logo 下方；暂未接搜索逻辑，折叠态隐藏 -->
        <UInput
          v-if="!collapsed"
          v-model="sidebarSearch"
          icon="i-lucide-search"
          placeholder="搜索"
          size="sm"
          class="w-full shrink-0"
        />
        <UNavigationMenu
          class="shrink-0"
          :collapsed="collapsed"
          :items="navItems"
          orientation="vertical"
          tooltip
          popover
        />
        <FeedNavigation
          :collapsed="collapsed"
          :scrollable="!compactSidebar"
        />
      </template>

      <template #footer="{ collapsed }">
        <!-- 通知按钮仍然下线，恢复时一并放开 notificationsOpen 与 NotificationsSlideover
        <UTooltip
          text="通知"
          :shortcuts="['N']"
          :disabled="!collapsed"
        >
          <UButton
            color="neutral"
            variant="ghost"
            :class="[
              collapsed ? 'px-0 w-full justify-center' : 'square'
            ]"
            @click="() => { notificationsOpen = !notificationsOpen }"
          >
            <UChip
              color="error"
              inset
            >
              <UIcon
                name="i-lucide-bell"
                class="size-5 shrink-0"
              />
            </UChip>
          </UButton>
        </UTooltip>
        -->
        <UserMenu :collapsed="collapsed" />
      </template>
    </UDashboardSidebar>

    <slot />

    <!-- 第三栏：与 <slot />（页面面板）同级，构成「侧边栏 | 列表 | 正文」三栏 -->
    <EntryReaderPane v-if="readerPane" />

    <!-- 通知面板暂时下线，与底部通知按钮一起恢复
    <NotificationsSlideover v-model:open="notificationsOpen" />
    -->
    <EntryDetailModal v-if="!readerPane" />

    <!-- 移动端底部导航：固定贴屏幕底边，三格等分；高度与上面 UDashboardGroup 的 pb 成对 -->
    <UNavigationMenu
      class="fixed inset-x-0 bottom-0 z-40 h-[calc(2.5rem_+_env(safe-area-inset-bottom))] border-t border-default bg-default px-2 pb-[env(safe-area-inset-bottom)] lg:hidden"
      orientation="horizontal"
      variant="link"
      color="primary"
      :items="mobileNavItems"
      :ui="mobileNavUi"
    />
  </UDashboardGroup>
</template>
