<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import type { McpToken, McpTokenCreated } from '~/types/mcp'
import { resolveApiBase } from '~/utils/apiBase'

const api = useApi()
const toast = useToast()
const { public: { apiBaseUrl } } = useRuntimeConfig()

/** MCP 端点地址（供填入客户端配置） */
const mcpUrl = computed(() => `${resolveApiBase(apiBaseUrl)}/mcp`)

// ── Token 列表 ──
const tokens = ref<McpToken[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

// ── 生成 token ──
const creating = ref(false)
const newTokenName = ref('')
const newTokenExpireDays = ref(30)
const expireOptions = [
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '365 天', value: 365 },
  { label: '永久', value: 0 }
]

/** 生成后一次性展示的明文（仅保持在内存，刷新即丢，关闭后清空） */
const justCreated = ref<McpTokenCreated | null>(null)

// ── 删除确认 ──
const deletingToken = ref<McpToken | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
const deleteOpen = computed({
  get: () => deletingToken.value !== null,
  set: (v: boolean) => { if (!v) deletingToken.value = null }
})

// ── 复制 ──
const { copy } = useClipboard({ legacy: true })
const copiedId = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

// ── 自动填入配置的提示 ──
const configEl = ref<HTMLElement | null>(null)
/** 是否刚生成令牌、且配置已自动填入（用于高亮提示「已自动填入」） */
const autoFilled = ref(false)
let autoFillTimer: ReturnType<typeof setTimeout> | null = null

/** 生成令牌后：配置里已自动填入，滚动到配置区并短暂高亮提示 */
function flashAutoFilled() {
  autoFilled.value = true
  if (autoFillTimer) clearTimeout(autoFillTimer)
  autoFillTimer = setTimeout(() => (autoFilled.value = false), 4000)
  // 滚动到配置区块，让用户直接复制
  configEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function copyText(text: string, id: string) {
  await copy(text)
  toast.add({ title: '已复制到剪贴板', color: 'success' })
  copiedId.value = id
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copiedId.value = null), 2000)
}

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    tokens.value = await api.tokens.list()
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function createToken() {
  creating.value = true
  try {
    const created = await api.tokens.create({
      name: newTokenName.value.trim() || 'MCP 助手',
      expiresInDays: newTokenExpireDays.value > 0 ? newTokenExpireDays.value : undefined
    })
    justCreated.value = created
    newTokenName.value = ''
    await load()
    // 配置区已自动填入该令牌，滚动过去并提示，方便直接复制
    flashAutoFilled()
  } catch (e) {
    toast.add({ title: '生成失败', description: errorMessage(e), color: 'error' })
  } finally {
    creating.value = false
  }
}

async function confirmDelete() {
  if (!deletingToken.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await api.tokens.remove(deletingToken.value.id)
    toast.add({ title: '已删除', description: deletingToken.value.name, color: 'success' })
    deletingToken.value = null
    await load()
  } catch (e) {
    deleteError.value = errorMessage(e)
  } finally {
    deleting.value = false
  }
}

function tokenStatus(t: McpToken): { label: string, color: 'success' | 'error' } {
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return { label: '已过期', color: 'error' }
  return { label: '有效', color: 'success' }
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

// ── 各客户端接入配置示例 ──
/** 生成一份带指定 token 的统一 MCP 配置 JSON（所有客户端共用同一份） */
function clientConfig(serverUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      rssfed: {
        type: 'http',
        url: serverUrl,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }, null, 2)
}

/**
 * 各客户端仅展示「操作步骤」，不再各自重复一份相同的 JSON 配置。
 * 所有客户端共用上方统一的 MCP 配置 JSON（含当前自动填入的令牌）。
 */
const clientSteps = [
  {
    name: 'Cursor',
    icon: 'i-lucide-scan-face',
    steps: 'Cursor → Settings → MCP → 添加，把上方的 JSON 配置直接粘贴进去。'
  },
  {
    name: 'Claude Desktop',
    icon: 'i-lucide-message-square',
    steps: 'Claude → Settings → Developer → Edit Config，将上方 JSON 粘贴到 claude_desktop_config.json 并保存。'
  },
  {
    name: 'Cherry Studio',
    icon: 'i-lucide-sparkles',
    steps: 'Cherry Studio → 设置 → MCP 服务器 → 添加，URL 填下方 MCP 端点地址，类型选 HTTP，并填上方令牌作为 Authorization。'
  },
  {
    name: 'Cline / Roo Code (VS Code)',
    icon: 'i-lucide-code-xml',
    steps: 'VS Code 插件 → MCP Servers → 添加 HTTP server，将上方 JSON 配置粘贴进去。'
  }
]

/** 示例配置里填入的令牌：优先用「刚生成」的明文令牌；否则提示用户粘贴 */
const exampleToken = computed(() => justCreated.value?.token ?? '粘贴你的令牌')
/** 是否已有一个刚生成、可自动填入的明文令牌 */
const hasFreshToken = computed(() => justCreated.value != null)

/** 统一的 MCP 配置 JSON（自动带上当前令牌，生成令牌后即时刷新） */
const unifiedConfig = computed(() => clientConfig(mcpUrl.value, exampleToken.value))

onMounted(load)
</script>

<template>
  <div class="space-y-8">
    <!-- 简介 -->
    <UCard>
      <div class="flex items-start gap-3">
        <UIcon
          name="i-lucide-bot"
          class="size-6 text-primary shrink-0 mt-0.5"
        />
        <div class="space-y-2">
          <h3 class="text-base font-bold">
            AI 助手（MCP）
          </h3>
          <p class="text-sm text-muted">
            通过标准 MCP（Model Context Protocol）接入你的 RSSFed 订阅，AI 助手即可帮你
            <span class="text-foreground">推荐新源、添加/取消订阅、暂停抓取、整理 Bot 分组、读取内容</span>。
            你的数据始终由服务端按登录用户隔离，AI 只能操作你自己授权的订阅。
          </p>
        </div>
      </div>
    </UCard>

    <!-- 步骤一：生成 token -->
    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          1
        </UBadge>
        <h4 class="text-sm font-bold">
          生成你的接入令牌（API Token）
        </h4>
      </div>

      <UCard>
        <div class="flex flex-col gap-4">
          <!-- 一次性明文展示 -->
          <UAlert
            v-if="justCreated"
            color="primary"
            variant="soft"
            title="令牌已生成，请立即保存"
            icon="i-lucide-key-round"
          >
            <template #description>
              <div class="space-y-2">
                <p class="text-sm">
                  下面这串 <span class="font-semibold">令牌只显示这一次</span>，关闭或刷新后将无法再次查看。请立即复制并妥善保存。
                </p>
                <div class="flex items-center gap-2">
                  <UInput
                    :model-value="justCreated.token"
                    :readonly="true"
                    class="flex-1 font-mono"
                  />
                  <UButton
                    size="sm"
                    variant="outline"
                    icon="i-lucide-copy"
                    @click="copyText(justCreated.token, 'fresh-token')"
                  >
                    复制
                  </UButton>
                </div>
                <p class="text-xs text-muted">
                  {{ justCreated.prefix }} · 创建于 {{ fmtTime(justCreated.createdAt) }}
                  {{ justCreated.expiresAt ? ` · ${fmtTime(justCreated.expiresAt)} 过期` : ' · 永不过期' }}
                </p>
              </div>
            </template>
            <template #actions>
              <UButton
                size="sm"
                color="neutral"
                variant="soft"
                @click="justCreated = null"
              >
                我已保存
              </UButton>
            </template>
          </UAlert>

          <!-- 生成表单 -->
          <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
            <UFormField
              label="令牌名称"
              class="flex-1"
            >
              <UInput
                v-model="newTokenName"
                placeholder="如：Cursor / Claude"
                icon="i-lucide-tag"
                clearable
              />
            </UFormField>
            <UFormField
              label="有效期"
              class="sm:w-40"
            >
              <USelect
                v-model="newTokenExpireDays"
                :items="expireOptions"
                value-key="value"
              />
            </UFormField>
            <UButton
              color="primary"
              icon="i-lucide-plus"
              :loading="creating"
              @click="createToken"
            >
              生成令牌
            </UButton>
          </div>

          <!-- 已生成的令牌列表 -->
          <div class="space-y-2 pt-2">
            <p class="text-xs font-semibold text-muted uppercase tracking-wide">
              已生成的令牌
            </p>

            <UAlert
              v-if="loadError"
              color="error"
              variant="soft"
              title="加载令牌失败"
              icon="i-lucide-circle-alert"
            >
              <template #description>
                {{ loadError }}
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

            <div
              v-if="loading"
              class="space-y-2"
            >
              <USkeleton
                v-for="i in 2"
                :key="i"
                class="h-12 w-full"
              />
            </div>

            <div
              v-else-if="!tokens.length"
              class="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted"
            >
              还没有令牌。点击上方「生成令牌」创建一个。
            </div>

            <ul
              v-else
              class="divide-y divide-elevated rounded-xl border border-elevated"
            >
              <li
                v-for="t in tokens"
                :key="t.id"
                class="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium truncate">{{ t.name }}</span>
                    <UBadge
                      :color="tokenStatus(t).color"
                      variant="subtle"
                      size="xs"
                    >
                      {{ tokenStatus(t).label }}
                    </UBadge>
                  </div>
                  <p class="text-xs text-muted truncate">
                    {{ t.prefix }} · {{ fmtTime(t.createdAt) }} 创建
                    <template v-if="t.lastUsedAt">
                      · {{ fmtTime(t.lastUsedAt) }} 用过
                    </template>
                    <template v-if="t.expiresAt">
                      · {{ fmtTime(t.expiresAt) }} 过期
                    </template>
                  </p>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <UButton
                    size="sm"
                    variant="outline"
                    color="error"
                    icon="i-lucide-trash-2"
                    @click="deletingToken = t"
                  >
                    删除
                  </UButton>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </UCard>
    </section>

    <!-- 步骤二：配置客户端 -->
    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          2
        </UBadge>
        <h4 class="text-sm font-bold">
          在支持的客户端里接入
        </h4>
      </div>

      <UCard>
        <div class="space-y-4">
          <UAlert
            v-if="!hasFreshToken"
            color="neutral"
            variant="soft"
            title="把你的令牌粘贴到配置里"
            icon="i-lucide-key-round"
          >
            <template #description>
              下方统一配置里令牌显示为「粘贴你的令牌」。请把上面生成的令牌（或你自己保存的令牌）粘贴替换后再复制。令牌只显示一次，请务必先复制保存。
            </template>
          </UAlert>

          <!-- 自动填入提示：生成令牌后短暂高亮 -->
          <UAlert
            v-if="autoFilled"
            color="success"
            variant="soft"
            title="令牌已自动填入下方配置"
            icon="i-lucide-circle-check"
          >
            <template #description>
              刚生成的令牌已写进下方的 JSON 配置并替换「粘贴你的令牌」。直接点击「复制配置」即可粘贴到任意客户端使用。
            </template>
          </UAlert>

          <!-- 统一 MCP 配置（一份 JSON，所有客户端共用） -->
          <div
            ref="configEl"
            class="rounded-lg border p-3 transition-colors"
            :class="autoFilled ? 'border-primary bg-primary/5' : 'border-elevated bg-elevated'"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <UIcon
                  name="i-lucide-terminal"
                  class="size-4 text-primary shrink-0"
                />
                <p class="text-xs font-semibold text-foreground">
                  MCP 配置（JSON）
                </p>
              </div>
              <UButton
                size="xs"
                variant="outline"
                :icon="copiedId === 'unified-config' ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copiedId === 'unified-config' ? '已复制' : '复制配置'"
                @click="copyText(unifiedConfig, 'unified-config')"
              />
            </div>
            <pre class="mt-2 overflow-x-auto text-xs leading-relaxed"><code>{{ unifiedConfig }}</code></pre>
          </div>

          <!-- 各客户端接入步骤（不再重复 JSON） -->
          <div class="grid gap-2 sm:grid-cols-2">
            <div
              v-for="client in clientSteps"
              :key="client.name"
              class="flex items-start gap-3 rounded-lg border border-elevated p-3"
            >
              <UIcon
                :name="client.icon"
                class="size-4 text-muted shrink-0 mt-0.5"
              />
              <div class="min-w-0 space-y-1">
                <p class="text-sm font-semibold">
                  {{ client.name }}
                </p>
                <p class="text-xs text-muted">
                  {{ client.steps }}
                </p>
              </div>
            </div>
          </div>

          <!-- MCP 地址单独展示 -->
          <div class="rounded-lg bg-elevated p-3">
            <p class="text-xs text-muted">
              MCP 端点地址
            </p>
            <div class="mt-1 flex items-center gap-2">
              <code class="text-xs break-all">{{ mcpUrl }}</code>
              <UButton
                size="xs"
                variant="ghost"
                :icon="copiedId === 'mcp-url' ? 'i-lucide-check' : 'i-lucide-copy'"
                @click="copyText(mcpUrl, 'mcp-url')"
              />
            </div>
          </div>
        </div>
      </UCard>
    </section>

    <!-- 步骤三：开始使用 -->
    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <UBadge
          color="primary"
          variant="subtle"
        >
          3
        </UBadge>
        <h4 class="text-sm font-bold">
          开始使用
        </h4>
      </div>

      <UCard>
        <ul class="space-y-3 text-sm">
          <li class="flex gap-2">
            <UIcon
              name="i-lucide-check"
              class="size-4 text-primary shrink-0"
            />
            <span>在客户端对话框里用自然语言提出需求，例如：<span class="text-muted">“把我最近的订阅列出来”</span>、<span class="text-muted">“订阅这个 RSS 源 https://…/feed.xml”</span>、<span class="text-muted">“把订阅按分类整理成 Bot 分组”</span>。</span>
          </li>
          <li class="flex gap-2">
            <UIcon
              name="i-lucide-check"
              class="size-4 text-primary shrink-0"
            />
            <span>AI 会调用对应的订阅管理工具完成操作，并回读结果给你确认。</span>
          </li>
          <li class="flex gap-2">
            <UIcon
              name="i-lucide-check"
              class="size-4 text-primary shrink-0"
            />
            <span>令牌可随时在上方删除；只在信任的设备/客户端上使用。</span>
          </li>
          <li class="flex gap-2">
            <UIcon
              name="i-lucide-shield-check"
              class="size-4 text-primary shrink-0"
            />
            <span><b>安全</b>：令牌只授权你本人的订阅数据，AI 无法访问其他用户或管理员操作。</span>
          </li>
        </ul>
      </UCard>
    </section>

    <!-- 删除确认弹窗 -->
    <UModal
      v-model:open="deleteOpen"
      title="删除令牌"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <p class="text-sm text-muted">
          删除后「{{ deletingToken?.name }}」（{{ deletingToken?.prefix }}）将立即失效，所有使用该令牌的客户端都会断开。此操作不可撤销。
        </p>
        <UAlert
          v-if="deleteError"
          color="error"
          variant="soft"
          :title="deleteError"
          icon="i-lucide-circle-alert"
          class="mt-3"
        />
      </template>
      <template #footer="{ close }">
        <UButton
          variant="outline"
          color="neutral"
          @click="close"
        >
          取消
        </UButton>
        <UButton
          color="error"
          :loading="deleting"
          @click="confirmDelete"
        >
          确认删除
        </UButton>
      </template>
    </UModal>
  </div>
</template>
