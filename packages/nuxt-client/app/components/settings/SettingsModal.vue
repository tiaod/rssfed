<script setup lang="ts">
/**
 * 设置弹窗：左侧分区导航 + 右侧内容。
 *
 * 设置从「独立页面 + 标签页」改成弹窗，是因为打开设置时用户通常正读到一半：
 * 原先跳到 /profile 会丢掉列表与滚动位置（宽屏下连右侧阅读栏都会关掉）。
 *
 * 弹窗只负责外壳与分区切换；各分区自己的状态（草稿、加载、确认弹窗）留在各自组件里，
 * 于是关掉弹窗时它们一起卸载 —— 草稿自然丢弃，下次打开总是已保存的值。
 *
 * 布局用自定义 `content` 槽位而不是 UModal 默认的 header / body / footer：
 * 默认版式是「标题在上、正文在下」，做不出左侧导航这一栏。传 `title` 是为了让
 * reka 的 DialogTitle 拿到可访问名（Nuxt UI 在 content 槽位下会把它放进 VisuallyHidden）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import SettingsGeneralSection from '~/components/settings/SettingsGeneralSection.vue'
import SettingsDataSection from '~/components/settings/SettingsDataSection.vue'
import McpSetupPanel from '~/components/settings/McpSetupPanel.vue'
import { SETTINGS_SECTIONS, useSettingsModal } from '~/composables/useSettingsModal'

const { isOpen, section } = useSettingsModal()

const current = computed(
  () => SETTINGS_SECTIONS.find(item => item.value === section.value) ?? SETTINGS_SECTIONS[0]!
)

/**
 * 内容区的滚动容器。
 *
 * 切换分区时必须把滚动位置归零：容器是同一个 DOM 节点，浏览器会保留 scrollTop，
 * 从「数据」（滚到很下面）切到「AI 助手」时，新分区一进来就已经被滚掉一截 ——
 * 看起来就像首屏卡片的上边框被吃掉。
 */
const scrollEl = ref<HTMLElement | null>(null)

/**
 * 窄屏横向分区条：把当前分区滚进视野。
 *
 * 分区条只有窄屏出现，且分区变多之后一行放不下（手机宽度约放得下 3 个）。
 * 分区也可能从外部被指定（时间线的「查看同步日志」直接落到「数据」），
 * 那时被选中的按钮往往在滚动区外面 —— 用户看到的是「点了没高亮」。
 */
const mobileTabRow = ref<HTMLElement | null>(null)

function revealActiveMobileTab(): void {
  const row = mobileTabRow.value
  if (!row) return
  const active = row.querySelector<HTMLElement>('[aria-current="page"]')
  if (!active) return
  // inline: 'center' 而不是 'nearest'：贴边时高亮块会被滚动条的圆角切掉一半
  active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
}

watch([section, isOpen], async () => {
  await nextTick()
  scrollEl.value?.scrollTo({ top: 0 })
  revealActiveMobileTab()
})

/**
 * 弹窗尺寸：宽到能放下「说明在左、控件在右」的双栏，高到不超过视口。
 *
 * 用 sm:max-w-* 断点变体覆盖 UModal 的基础 max-w-lg（同一属性后写生效），
 * 比直接写 max-w 更稳。高度用 dvh，手机上不会被地址栏顶掉一截。
 *
 * 关掉内置的关闭按钮（`:close="false"`）：它的落点是「内容右上角」，而这里的右上角
 * 属于内容区的滚动条轨道，按钮会盖在滚动条上；标题行自己放一个更合适。
 */
const modalUi = {
  content: 'w-[calc(100vw-2rem)] sm:max-w-5xl h-[min(88dvh,48rem)] flex flex-col overflow-hidden',
  // 内容槽自己管内边距与滚动，默认的 body 内边距必须清掉（合并语义，只写 p-0 不够）
  body: 'p-0 sm:p-0'
}

/**
 * 订阅管理入口（左侧导航底部，带一个外链样式的小图标）。
 *
 * 它不是设置分区：不切换右侧内容，点一下就离开弹窗去整页 —— 订阅列表长、整理时还要
 * 来回开编辑弹窗，塞不进这个弹窗。因此图标走 trailing 位、独立于上面的分区按钮。
 *
 * 必须显式先关弹窗：弹窗挂在 default 布局上（不在页面里），跳页不会卸载它，
 * 不关的话新页面上会继续盖着一层设置。
 */
async function openSubscriptions(closeModal: () => void): Promise<void> {
  closeModal()
  await navigateTo('/subscriptions')
}
</script>

<template>
  <UModal
    v-model:open="isOpen"
    title="设置"
    :close="false"
    :ui="modalUi"
  >
    <template #content="{ close: closeModal }">
      <div class="flex min-h-0 flex-1">
        <!-- 左侧分区导航：窄屏收起（改为内容区顶部的横向标签） -->
        <aside
          class="hidden w-56 shrink-0 flex-col gap-1 border-e border-default p-3 sm:flex"
        >
          <p class="px-2 pb-2 pt-1 text-lg font-semibold text-highlighted">
            设置
          </p>
          <UButton
            v-for="item in SETTINGS_SECTIONS"
            :key="item.value"
            :icon="item.icon"
            :label="item.label"
            block
            size="md"
            :color="section === item.value ? 'primary' : 'neutral'"
            :variant="section === item.value ? 'soft' : 'ghost'"
            class="justify-start"
            :aria-current="section === item.value ? 'page' : undefined"
            @click="section = item.value"
          />

          <!-- 订阅管理不属于设置分区：点一下就关弹窗跳页，trailing 图标表明「会离开这里」 -->
          <div class="my-1 border-t border-default" />
          <UButton
            class="justify-start"
            icon="i-lucide-rss"
            trailing-icon="i-lucide-external-link"
            label="订阅管理"
            block
            size="md"
            color="neutral"
            variant="ghost"
            @click="openSubscriptions(closeModal)"
          />
        </aside>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <header class="flex shrink-0 items-center gap-2 px-5 py-3 sm:px-6">
            <h2 class="text-base font-semibold text-highlighted">
              {{ current.label }}
            </h2>
            <UButton
              class="ms-auto"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="关闭设置"
              @click="closeModal()"
            />
          </header>

          <!--
            窄屏分区切换：横向排一行。
            - 放不下时左右滑动（`overflow-x-auto` + 每项 `shrink-0`），滚动条隐藏 ——
              这是手机上常见的横向标签，露出一条始终存在的灰条只会显得像故障；
            - 用 -mx-4/px-4 让滚动区铺到弹窗边缘：内边距写在外层会让首尾两项在
              滚到端点时永远贴不到边，看起来像「还能继续滚」；
            - scroll-px-4 让 scrollIntoView 居中时给首尾留出同样的呼吸位。
          -->
          <div
            ref="mobileTabRow"
            class="-mx-4 flex shrink-0 gap-1 overflow-x-auto scroll-px-4 px-4 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] sm:hidden [&::-webkit-scrollbar]:hidden"
          >
            <UButton
              v-for="item in SETTINGS_SECTIONS"
              :key="item.value"
              :icon="item.icon"
              :label="item.label"
              size="sm"
              :color="section === item.value ? 'primary' : 'neutral'"
              :variant="section === item.value ? 'soft' : 'ghost'"
              :aria-current="section === item.value ? 'page' : undefined"
              class="shrink-0"
              @click="section = item.value"
            />
            <!-- 与左侧竖导航同一个入口：窄屏收起 aside 后，这里不能只剩三个分区 -->
            <div class="mx-1 shrink-0 self-stretch border-s border-default" />
            <UButton
              class="shrink-0"
              size="sm"
              icon="i-lucide-rss"
              trailing-icon="i-lucide-external-link"
              label="订阅管理"
              color="neutral"
              variant="ghost"
              @click="openSubscriptions(closeModal)"
            />
          </div>

          <!--
            顶部留出 pt-2：滚动容器本身会裁掉溢出内容，第一张卡片若贴着容器上沿，
            它的圆角上边框正好压在裁切线上（看起来像边框被吃掉）。pb 同理。
          -->
          <div
            ref="scrollEl"
            class="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2 sm:px-6"
          >
            <SettingsGeneralSection v-if="section === 'general'" />
            <McpSetupPanel v-else-if="section === 'ai'" />
            <SettingsDataSection v-else-if="section === 'data'" />
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
