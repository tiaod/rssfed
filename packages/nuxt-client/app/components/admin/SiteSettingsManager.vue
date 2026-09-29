<script setup lang="ts">
import { PWA_DISPLAY_MODES } from '~/types/site'
// 显式导入：与 profile.vue 引用本目录组件的写法保持一致，不依赖自动导入名的推断
import SiteColorField from '~/components/admin/SiteColorField.vue'

const api = useApi()
const toast = useToast()
const siteSettings = useSiteSettings()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

/** 表单草稿：logo / PWA 图标 单独即时保存，其余字段点「保存」统一提交 */
const form = ref({
  siteTitle: '',
  description: '',
  primaryColor: '',
  skin: '',
  pwaShortName: '',
  pwaDisplay: '',
  pwaThemeColor: '',
  pwaBackgroundColor: ''
})
const logoUrl = ref<string | null>(null)
const iconUrl = ref<string | null>(null)

const logoInput = ref<HTMLInputElement | null>(null)
const iconInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadingIcon = ref(false)

/** 图标预览的防缓存计数：上传/删除后递增，强制浏览器重新取图 */
const previewBust = ref(0)

/**
 * 预览直接指向后端实际渲染的图标端点，所见即手机上装出来的样子。
 * 不拼 manifest 里的 `?v=`（那是版本化长缓存），改用自增参数保证改完立刻可见。
 */
const iconPreviewUrl = computed(() => `/api/site-settings/icon/192.png?t=${previewBust.value}`)

/** 显示模式选项：空值表示跟随后端默认（standalone） */
const displayItems = [
  { label: '跟随默认（独立窗口）', value: '' },
  ...PWA_DISPLAY_MODES.map(mode => ({ label: mode.label, value: mode.value }))
]

/** 当前显示模式的说明文案，帮管理员理解各模式的差别 */
const displayHint = computed(() =>
  PWA_DISPLAY_MODES.find(mode => mode.value === form.value.pwaDisplay)?.description
  ?? '留空时使用「独立窗口」：隐藏浏览器地址栏，最接近原生应用'
)

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

/** 空串视为「恢复默认」，后端以 null 落库 */
function toNullable(v: string) {
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const s = await api.admin.siteSettings.get()
    form.value = {
      siteTitle: s.siteTitle ?? '',
      description: s.description ?? '',
      primaryColor: s.primaryColor ?? '',
      skin: s.skin ?? '',
      pwaShortName: s.pwaShortName ?? '',
      pwaDisplay: s.pwaDisplay ?? '',
      pwaThemeColor: s.pwaThemeColor ?? '',
      pwaBackgroundColor: s.pwaBackgroundColor ?? ''
    }
    logoUrl.value = s.logoUrl ?? null
    iconUrl.value = s.pwaIconUrl ?? null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await api.admin.siteSettings.update({
      siteTitle: toNullable(form.value.siteTitle),
      description: toNullable(form.value.description),
      primaryColor: toNullable(form.value.primaryColor)?.toLowerCase() ?? null,
      skin: toNullable(form.value.skin),
      pwaShortName: toNullable(form.value.pwaShortName),
      pwaDisplay: toNullable(form.value.pwaDisplay),
      pwaThemeColor: toNullable(form.value.pwaThemeColor)?.toLowerCase() ?? null,
      pwaBackgroundColor: toNullable(form.value.pwaBackgroundColor)?.toLowerCase() ?? null
    })
    toast.add({ title: '站点设置已保存', color: 'success' })
    void siteSettings.refresh()
    // 同一份图标来源可能只是换了底色，缓存键里含底色，这里主动刷预览
    previewBust.value++
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

/** 选择文件后立即上传（S3 + attachments），无需等「保存」 */
async function handleLogoChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  try {
    const r = await api.admin.siteSettings.uploadLogo(file)
    logoUrl.value = r.logoUrl
    toast.add({ title: 'Logo 已更新', color: 'success' })
    void siteSettings.refresh()
    previewBust.value++
  } catch (err) {
    toast.add({ title: '上传失败', description: errorMessage(err), color: 'error' })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function removeLogo() {
  try {
    await api.admin.siteSettings.deleteLogo()
    logoUrl.value = null
    toast.add({ title: '已恢复默认 Logo', color: 'success' })
    void siteSettings.refresh()
    previewBust.value++
  } catch (err) {
    toast.add({ title: '删除失败', description: errorMessage(err), color: 'error' })
  }
}

async function handleIconChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingIcon.value = true
  try {
    const r = await api.admin.siteSettings.uploadIcon(file)
    iconUrl.value = r.pwaIconUrl
    toast.add({ title: 'PWA 图标已更新', color: 'success' })
    void siteSettings.refresh()
    previewBust.value++
  } catch (err) {
    toast.add({ title: '上传失败', description: errorMessage(err), color: 'error' })
  } finally {
    uploadingIcon.value = false
    input.value = ''
  }
}

async function removeIcon() {
  try {
    await api.admin.siteSettings.deleteIcon()
    iconUrl.value = null
    toast.add({ title: '已移除 PWA 图标，将改用站点 Logo', color: 'success' })
    void siteSettings.refresh()
    previewBust.value++
  } catch (err) {
    toast.add({ title: '删除失败', description: errorMessage(err), color: 'error' })
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      title="加载失败"
      icon="i-lucide-circle-alert"
    >
      <template #description>
        {{ error }}
      </template>
      <template #actions>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          @click="load"
        >
          重试
        </UButton>
      </template>
    </UAlert>

    <template v-else-if="loading">
      <USkeleton class="h-32 w-full rounded-xl" />
      <USkeleton class="h-32 w-full rounded-xl" />
    </template>

    <template v-else>
      <!-- Logo -->
      <UFormField
        label="站点 Logo"
        description="上传后在站点各处展示站长设定的图形（离线时由 Service Worker 缓存可用）"
      >
        <div class="flex items-center gap-3">
          <UAvatar
            v-if="logoUrl"
            :src="logoUrl"
            alt="站点 Logo"
            size="xl"
          />
          <UAvatar
            v-else
            text="R"
            size="xl"
            color="primary"
          />
          <div class="flex flex-col gap-2 sm:flex-row">
            <UButton
              icon="i-lucide-upload"
              variant="outline"
              :loading="uploading"
              @click="logoInput?.click()"
            >
              上传
            </UButton>
            <input
              ref="logoInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleLogoChange"
            >
            <UButton
              v-if="logoUrl"
              icon="i-lucide-trash"
              variant="ghost"
              color="error"
              @click="removeLogo"
            >
              移除
            </UButton>
          </div>
        </div>
      </UFormField>

      <!-- 品牌 -->
      <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
        品牌
      </h3>

      <UFormField label="站点标题">
        <UInput
          v-model="form.siteTitle"
          class="w-full"
          placeholder="RSSFed"
        />
      </UFormField>

      <UFormField label="描述">
        <UTextarea
          v-model="form.description"
          class="w-full"
          :rows="2"
          placeholder="一句话介绍当前站点"
        />
      </UFormField>

      <!-- 外观 -->
      <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
        外观
      </h3>

      <SiteColorField
        v-model="form.primaryColor"
        label="主题色"
        description="主色调（hex）。留空使用应用内置默认主题"
      />

      <UFormField
        label="皮肤"
        description="皮肤标识（占位字段：皮肤体系尚未定义，可先存名字；留空使用默认皮肤）"
      >
        <UInput
          v-model="form.skin"
          class="w-64"
          placeholder="默认"
        />
      </UFormField>

      <!-- PWA：安装到手机 -->
      <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
        PWA（安装到手机）
      </h3>

      <UAlert
        color="neutral"
        variant="soft"
        icon="i-lucide-info"
        title="站点已支持安装到手机主屏幕"
        description="浏览器读取 /api/site-settings/manifest.webmanifest 自动生成安装信息，名称、图标与配色均取自下方配置。改动后手机上需重新「添加到主屏幕」才会更新已安装图标。"
      />

      <UFormField
        label="PWA 方形图标"
        description="主屏幕图标。留空时使用站点 Logo 裁剪；两者都没有时使用内置默认图形（底色跟随主题色）。建议上传方形图片"
      >
        <div class="flex items-center gap-3">
          <img
            :src="iconPreviewUrl"
            alt="PWA 图标预览"
            class="size-16 rounded-xl object-contain ring-1 ring-default"
          >
          <div class="flex flex-col gap-2 sm:flex-row">
            <UButton
              icon="i-lucide-upload"
              variant="outline"
              :loading="uploadingIcon"
              @click="iconInput?.click()"
            >
              上传
            </UButton>
            <input
              ref="iconInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleIconChange"
            >
            <UButton
              v-if="iconUrl"
              icon="i-lucide-trash"
              variant="ghost"
              color="error"
              @click="removeIcon"
            >
              移除
            </UButton>
          </div>
          <p class="text-xs text-muted">
            {{ iconUrl ? '当前使用上传的方形图标' : (logoUrl ? '当前使用站点 Logo 裁剪' : '当前使用内置默认图形') }}
          </p>
        </div>
      </UFormField>

      <UFormField
        label="主屏幕名称"
        description="装到主屏幕后图标下方的名字（建议 12 个字符以内）。留空时使用站点标题"
      >
        <UInput
          v-model="form.pwaShortName"
          class="w-64"
          placeholder="RSSFed"
        />
      </UFormField>

      <UFormField
        label="显示模式"
        :description="displayHint"
      >
        <USelect
          v-model="form.pwaDisplay"
          :items="displayItems"
          value-key="value"
          class="w-64"
        />
      </UFormField>

      <SiteColorField
        v-model="form.pwaThemeColor"
        label="PWA 主题色"
        description="安装后系统状态栏的着色（hex）。留空时沿用站点主题色"
      />

      <SiteColorField
        v-model="form.pwaBackgroundColor"
        label="PWA 背景色"
        description="启动画面底色，同时是图标底色（hex，会被填成不透明）。留空时沿用站点主题色"
        fallback-color="#ffffff"
        placeholder="#ffffff"
      />

      <div class="flex justify-start">
        <UButton
          color="primary"
          icon="i-lucide-save"
          :loading="saving"
          @click="save"
        >
          保存设置
        </UButton>
      </div>
    </template>
  </div>
</template>
