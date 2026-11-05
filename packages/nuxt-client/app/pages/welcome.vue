<script setup lang="ts">
import { resolveInternalPath } from '~/utils/redirectTarget'

definePageMeta({
  layout: 'none'
})

const { settings } = useSiteSettings()
const userStore = useUserStore()
const route = useRoute()

/** 深链接被送到落地页时保留原目标；只接受站内路径，防开放重定向 */
const redirectTarget = computed(() => resolveInternalPath(route.query.redirect))

// 已登录用户不该停在介绍页：SSR 首帧就跳走，避免先闪一下落地页。
// SSR 的已登录判断来自 auth-session 插件写入的会话镜像（见 stores/user）。
if (userStore.user) {
  await navigateTo(redirectTarget.value)
}

// 客户端首帧会话可能还在恢复（store.user 暂时为空）：拿到明确用户后同样离开落地页
watch(() => userStore.user, (user) => {
  if (user) void navigateTo(redirectTarget.value)
})

const siteTitle = computed(() => settings.value.siteTitle?.trim() || 'RSSFed')
const siteDescription = computed(() =>
  settings.value.description?.trim() || '支持 ActivityPub 的 RSS 阅读器'
)

/** 从深链接来时才带 redirect；直接进落地页则交给登录页默认跳时间线 */
const loginTo = computed(() =>
  typeof route.query.redirect === 'string'
    ? { path: '/login', query: { redirect: redirectTarget.value } }
    : '/login'
)

const capabilities = [
  {
    icon: 'i-lucide-rss',
    title: 'RSS 资讯聚合',
    description: '订阅任意 RSS / Atom 源，定时抓取更新，把散落在各处的资讯收进同一条时间线。'
  },
  {
    icon: 'i-lucide-wifi-off',
    title: '离线优先阅读',
    description: '订阅与已读状态同步到浏览器本地，断网也能继续读；恢复联网后自动合并，多设备保持一致。'
  },
  {
    icon: 'i-lucide-share-2',
    title: 'ActivityPub 分发',
    description: '用 Bot 机器人把聚合内容推送到联邦宇宙，关注者在 Mastodon 等平台上就能直接看到。'
  }
] as const

const steps = [
  { title: '订阅感兴趣的源', description: '添加 RSS / Atom 地址，或导入现有的 OPML 订阅列表。' },
  { title: '服务端聚合去重', description: '定时抓取，每个源只保留最新内容，失效条目自动清理。' },
  { title: '阅读并分发', description: '在时间线里阅读、收藏、标记已读；需要时交给 Bot 推送到 Fediverse。' }
] as const

const details = [
  {
    icon: 'i-lucide-list',
    title: '跨源时间线',
    description: '所有订阅源汇成一条按时间排序的信息流，不用逐个站点翻。'
  },
  {
    icon: 'i-lucide-eye',
    title: '未读筛选',
    description: '只看还没读过的内容，读完自动标记，浏览记录随时可查。'
  },
  {
    icon: 'i-lucide-bookmark',
    title: '收藏与历史',
    description: '值得回看的内容一键收藏，历史入口按时间找回读过的文章。'
  },
  {
    icon: 'i-lucide-book-open',
    title: '舒适阅读',
    description: '正文图片随条目一起缓存，支持字号与字体调整、全文展开阅读。'
  },
  {
    icon: 'i-lucide-refresh-cw',
    title: '多端同步',
    description: '浏览器、手机、平板共享同一份订阅与已读状态，联网后自动合并。'
  },
  {
    icon: 'i-lucide-bot',
    title: 'Bot 生态',
    description: '把多个源组织成一个 Bot，用 ActivityPub 身份持续输出聚合内容。'
  }
] as const
</script>

<template>
  <div>
    <!-- Hero -->
    <section class="relative overflow-hidden">
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 -z-10"
      >
        <div class="absolute left-1/2 top-0 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div class="mx-auto max-w-5xl px-4 pt-16 pb-20 text-center sm:pt-24 sm:pb-24">
        <UBadge
          color="primary"
          variant="soft"
          size="lg"
        >
          开源 · 自托管 · 联邦宇宙
        </UBadge>
        <h1 class="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
          {{ siteTitle }}
        </h1>
        <p class="mx-auto mt-4 max-w-2xl text-lg text-muted">
          {{ siteDescription }}
        </p>
        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <UButton
            :to="loginTo"
            color="primary"
            size="lg"
            icon="i-lucide-log-in"
          >
            登录 / 注册
          </UButton>
          <UButton
            to="/welcome#features"
            color="neutral"
            variant="outline"
            size="lg"
            icon="i-lucide-arrow-down"
          >
            了解功能
          </UButton>
        </div>
        <p class="mt-4 text-sm text-muted">
          还没有账号？注册后即可开始订阅。
        </p>
      </div>
    </section>

    <!-- 三大核心能力 -->
    <section
      id="features"
      class="border-y border-default bg-elevated/40"
    >
      <div class="mx-auto max-w-5xl px-4 py-14 sm:py-16">
        <div class="grid gap-4 sm:grid-cols-3">
          <UCard
            v-for="item in capabilities"
            :key="item.title"
          >
            <div class="flex items-center gap-2">
              <UIcon
                :name="item.icon"
                class="size-5 text-primary"
              />
              <h2 class="font-semibold">
                {{ item.title }}
              </h2>
            </div>
            <p class="mt-2 text-sm leading-relaxed text-muted">
              {{ item.description }}
            </p>
          </UCard>
        </div>
      </div>
    </section>

    <!-- 使用流程 -->
    <section class="mx-auto max-w-5xl px-4 py-16 sm:py-20">
      <h2 class="text-center text-2xl font-bold sm:text-3xl">
        三步开始
      </h2>
      <p class="mt-2 text-center text-muted">
        从订阅到阅读，再到分发
      </p>
      <ol class="mt-10 grid gap-6 sm:grid-cols-3">
        <li
          v-for="(step, index) in steps"
          :key="step.title"
        >
          <div class="flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {{ index + 1 }}
          </div>
          <h3 class="mt-3 font-semibold">
            {{ step.title }}
          </h3>
          <p class="mt-1 text-sm leading-relaxed text-muted">
            {{ step.description }}
          </p>
        </li>
      </ol>
    </section>

    <!-- 细节特性 -->
    <section class="border-y border-default">
      <div class="mx-auto max-w-5xl px-4 py-14 sm:py-16">
        <div class="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          <div
            v-for="item in details"
            :key="item.title"
            class="flex gap-3"
          >
            <UIcon
              :name="item.icon"
              class="mt-0.5 size-5 shrink-0 text-primary"
            />
            <div>
              <h3 class="font-semibold">
                {{ item.title }}
              </h3>
              <p class="mt-1 text-sm text-muted">
                {{ item.description }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 底部 CTA -->
    <section class="mx-auto max-w-3xl px-4 py-16 text-center sm:py-20">
      <h2 class="text-2xl font-bold sm:text-3xl">
        把分散的更新，收进一条时间线
      </h2>
      <p class="mt-2 text-muted">
        订阅、阅读、分发都在这里完成。
      </p>
      <UButton
        :to="loginTo"
        color="primary"
        size="lg"
        icon="i-lucide-log-in"
        class="mt-6"
      >
        登录 / 注册
      </UButton>
    </section>
  </div>
</template>
