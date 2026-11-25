<script setup lang="ts">
/**
 * 设置弹窗 →「常规」分区：阅读偏好 + 同步开关。
 *
 * 本地偏好（useSettings，存 localStorage）与服务端每用户设置（useTimelineSettings，存 PG）
 * 仍然合用一个「保存」按钮：它们在同一屏里，拆成两个按钮反而更容易漏点其中一个
 * （沿用原「我的」页的处理）。关掉弹窗时整块卸载、草稿自然丢弃，下次打开总是已保存的值。
 */
import { computed, onMounted, ref, watch } from 'vue'
import SettingsGroup from '~/components/settings/SettingsGroup.vue'
import SettingsRow from '~/components/settings/SettingsRow.vue'
import type { AppSettings, EntryModalSize, ShareMethod } from '~/composables/useSettings'
import { LIST_VIEW_OPTIONS, type ListView } from '~/utils/listViews'
import {
  READER_FONTS,
  loadReaderFontCss,
  normalizeReaderFontId,
  resolveReaderFont
} from '~/utils/readerFonts'
import {
  READER_FONT_SCALE_MAX,
  READER_FONT_SCALE_MIN,
  READER_FONT_SCALE_STEP,
  normalizeReaderFontScale,
  readerFontSizeCss
} from '~/utils/readerFontSize'
import { timelineSettingsEqual } from '~/utils/timelineSettings'

const { settings, updateSettings } = useSettings()
const toast = useToast()

// 草稿：修改后需点击「保存」按钮才生效并持久化
const draftSettings = ref<AppSettings>({ ...settings.value })

/**
 * 时间线聚合设置（服务端，每用户一份）。
 *
 * 保存后服务端会催一次聚合，数据随后由 live 复制到端。
 */
const {
  settings: timelineSettings, loaded: timelineLoaded, saving: timelineSaving,
  error: timelineError, load: loadTimelineSettings, save: saveTimelineSettings
} = useTimelineSettings()
const draftTimeline = ref({ ...timelineSettings.value })

onMounted(() => {
  void loadTimelineSettings()
})

// 服务端设置到达后同步草稿（挂载时 load 是异步的）
watch(timelineSettings, (next) => {
  draftTimeline.value = { ...next }
})

/** 已保存的本地设置变了（例如另一个标签页改过）就重铺草稿 */
watch(settings, (next) => {
  draftSettings.value = { ...next }
}, { deep: true })

const saving = ref(false)

const saveSettings = async () => {
  updateSettings({ ...draftSettings.value })
  // 本地偏好与时间线聚合设置一起保存：时间线设置没变就不发请求
  if (timelineLoaded.value && !timelineSettingsEqual(draftTimeline.value, timelineSettings.value)) {
    saving.value = true
    try {
      await saveTimelineSettings({ ...draftTimeline.value })
      toast.add({ title: '设置已保存', color: 'success' })
    } catch (e: unknown) {
      toast.add({ title: '时间线设置保存失败', description: errorMessage(e), color: 'error' })
    } finally {
      saving.value = false
    }
    return
  }
  toast.add({ title: '设置已保存', color: 'success' })
}

// 条目详情模态宽度选项
const modalSizeOptions: { label: string, value: EntryModalSize }[] = [
  { label: '标准', value: 'sm:max-w-xl' },
  { label: '较宽', value: 'sm:max-w-2xl' },
  { label: '宽', value: 'sm:max-w-4xl' },
  { label: '很宽', value: 'sm:max-w-6xl' },
  { label: '全屏', value: 'fullscreen' }
]

// 分享方式：桌面端的系统分享面板往往不如复制顺手，所以让用户自己定
const shareMethodOptions: { label: string, value: ShareMethod }[] = [
  { label: '自动（手机用系统面板，电脑复制标题和链接）', value: 'auto' },
  { label: '系统分享面板', value: 'system' },
  { label: '复制标题和链接', value: 'clipboard' }
]

/**
 * 「正文字体」与「正文字号」：都只影响文章正文（.entry-prose），不动列表与界面文字；
 * 清单见 utils/readerFonts，字号百分比口径见 utils/readerFontSize。
 * 'inherit' / 100 本身就是合法选项值，不需要像 draftView 那样用哨兵字符串区分「未配置」。
 */
const readerFontOptions = READER_FONTS.map(font => ({ label: font.label, value: font.id }))

const draftReaderFont = computed({
  get: () => normalizeReaderFontId(draftSettings.value.readerFont),
  set: (value: string) => {
    draftSettings.value = {
      ...draftSettings.value,
      readerFont: normalizeReaderFontId(value)
    }
  }
})

const draftReaderFontScale = computed({
  get: () => normalizeReaderFontScale(draftSettings.value.readerFontScale),
  set: (value: number | number[] | undefined) => {
    // USlider 单滑块回传 number；类型上还允许数组，统一取第一个就够
    draftSettings.value = {
      ...draftSettings.value,
      readerFontScale: normalizeReaderFontScale(Array.isArray(value) ? value[0] : value)
    }
  }
})

// 预览区用它自己的字体渲染；选到自带字体时先把样式拉下来，
// 否则预览会显示回退后的系统字体，等于没预览
watch(draftReaderFont, (id) => {
  void loadReaderFontCss(id)
})

const readerFontPreviewStyle = computed(() => {
  const stack = resolveReaderFont(draftReaderFont.value).stack
  return {
    fontFamily: stack ?? undefined,
    // 预览块本身是 1rem 的界面字号，不显式写字号就看不出拖动滑块的效果；
    // 100% 在 CSS 里也是 1rem，这里补上同一个值
    fontSize: readerFontSizeCss(draftReaderFontScale.value) ?? '1rem'
  }
})

/**
 * 「默认列表视图」里的「跟随内置默认」项：选中它 = 不写设置（view 为 undefined）。
 *
 * 用一个哨兵字符串而不是空值：reka 的 Select 明确禁止选项值为空串（空串被它当作「清空选择」，
 * 传了整个下拉都打不开，见 EditSubscriptionModal 的同类注释）；undefined 又表示「未选中」，
 * 没法表达「显式选择：取消配置」这个动作。用户不选它时才落一个具体视图 —— 于是
 * 「没配过」与「配成瀑布流」区分得开，时间线的内置默认（社交动态）才生效。
 */
const INHERIT_VIEW = '__default__'

const viewOptions = [
  { label: '跟随内置默认', value: INHERIT_VIEW },
  ...LIST_VIEW_OPTIONS
]

const draftView = computed({
  get: () => draftSettings.value.view ?? INHERIT_VIEW,
  set: (value: string) => {
    draftSettings.value = {
      ...draftSettings.value,
      view: value === INHERIT_VIEW ? undefined : (value as ListView)
    }
  }
})
</script>

<template>
  <div class="space-y-6">
    <SettingsGroup label="阅读">
      <SettingsRow
        label="默认列表视图"
        icon="i-lucide-layout-grid"
        tone="blue"
        description="各列表页的默认视图；选「跟随内置默认」则不写配置 —— 时间线用「社交动态」，单个订阅源 / 分组 / 收藏页用「瀑布流」（列表页上的切换按钮只影响本次会话）"
      >
        <USelect
          v-model="draftView"
          :items="viewOptions"
          value-key="value"
          class="w-48"
        />
      </SettingsRow>

      <SettingsRow
        label="条目详情宽度"
        icon="i-lucide-panel-left"
        tone="blue"
        description="详情弹窗的窗口宽度；宽屏的右侧阅读栏还用它限制正文宽度，阅读栏拖得再宽，多出来的也是两边留白"
      >
        <USelect
          v-model="draftSettings.entryModalSize"
          :items="modalSizeOptions"
          value-key="value"
          class="w-40"
        />
      </SettingsRow>

      <SettingsRow
        label="固定顶部栏"
        icon="i-lucide-pin"
        tone="blue"
        description="全屏时固定顶栏、仅正文滚动；关闭后顶栏随文章一起滚走（居中弹窗与阅读栏的顶栏本来就常驻，不受此项影响）"
      >
        <USwitch v-model="draftSettings.fixedBars" />
      </SettingsRow>

      <SettingsRow
        label="分享方式"
        icon="i-lucide-share-2"
        tone="green"
        description="分享文章时用系统分享面板，还是复制「标题 + 原文链接」。「自动」按设备选择：手机 / 平板（触屏）弹系统面板，电脑复制标题和链接；浏览器没有系统面板时一律回退复制"
      >
        <USelect
          v-model="draftSettings.shareMethod"
          :items="shareMethodOptions"
          value-key="value"
          class="w-64"
        />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup label="正文排版">
      <SettingsRow
        label="正文字体"
        icon="i-lucide-type"
        tone="purple"
        description="只影响文章正文（条目详情与右侧阅读栏）。系统字体取决于本机已安装的字体，缺失时自动回退；霞鹜文楷（屏幕阅读版，SIL OFL 1.1）为内置字体，首次选择时按需下载用到的字形分片"
      >
        <USelect
          v-model="draftReaderFont"
          :items="readerFontOptions"
          value-key="value"
          class="w-56"
        />
      </SettingsRow>

      <SettingsRow
        label="正文字号"
        icon="i-lucide-a-large-small"
        tone="purple"
        description="只影响文章正文，标题与代码块按比例缩放。100% 为应用原本的字号；用 rem 计，系统/浏览器调大默认字号时正文会一起变大"
      >
        <div class="flex w-56 items-center gap-3">
          <USlider
            v-model="draftReaderFontScale"
            :min="READER_FONT_SCALE_MIN"
            :max="READER_FONT_SCALE_MAX"
            :step="READER_FONT_SCALE_STEP"
            class="flex-1"
            tooltip
          />
          <span class="w-12 shrink-0 text-right text-sm tabular-nums text-muted">{{ draftReaderFontScale }}%</span>
        </div>
      </SettingsRow>

      <!-- 预览：用它自己的字体与字号渲染当前草稿选择，省得保存后再回正文对比 -->
      <div class="px-4 py-3.5">
        <p
          class="rounded-md border border-default px-3 py-2 text-muted"
          :style="readerFontPreviewStyle"
        >
          字体与字号预览：这是一段示例文字，用来看字形的疏密、笔画与字号大小。
        </p>
      </div>
    </SettingsGroup>

    <SettingsGroup label="同步">
      <!--
        AI 摘要开关由**服务端**保存（每用户一份，见 useTimelineSettings）。
        图片参数不在这里：它是全局的，抓取时就压好了，用户改不了
        （原先按源调的入口随「订阅源管理」一起删除了）。
      -->
      <SettingsRow
        label="AI 摘要"
        icon="i-lucide-sparkles"
        tone="orange"
        description="为每条内容生成摘要。开关已经可以设置，生成链路还在开发中，开启后暂时不会产出摘要。"
      >
        <USwitch v-model="draftTimeline.aiSummaryEnabled" />
      </SettingsRow>
    </SettingsGroup>

    <p
      v-if="timelineError"
      class="text-sm text-error"
    >
      {{ timelineError }}
    </p>

    <div class="flex justify-end">
      <UButton
        color="primary"
        icon="i-lucide-save"
        :loading="saving || timelineSaving"
        @click="saveSettings"
      >
        保存设置
      </UButton>
    </div>
  </div>
</template>
