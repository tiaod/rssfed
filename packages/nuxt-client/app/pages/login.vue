<script setup lang="ts">
import { ref, computed } from 'vue'
import { useUserStore } from '~/stores/user'

/** 开发模式下可用的测试账号 */
const TEST_ACCOUNTS = [
  { label: '管理员', email: 'admin@example.com', password: 'Admin123!' },
  { label: '用户 #1', email: 'user1@test.com', password: 'Password123!' }
] as const

const mode = ref<'login' | 'register'>('login')
const email = ref(import.meta.dev ? TEST_ACCOUNTS[0].email : '')
const password = ref(import.meta.dev ? TEST_ACCOUNTS[0].password : '')
const name = ref('')
const error = ref('')
const loading = ref(false)

const isDev = import.meta.dev

const title = computed(() => (mode.value === 'login' ? '登录' : '注册'))

/** 快速填入指定测试账号 */
function fillTestAccount(index: number) {
  const account = TEST_ACCOUNTS[index]
  if (!account) return
  email.value = account.email
  password.value = account.password
}

async function handleSubmit() {
  error.value = ''
  loading.value = true

  try {
    if (mode.value === 'register') {
      const { error: err } = await useAuthClient().signUp.email({
        email: email.value,
        password: password.value,
        name: name.value
      })
      if (err) {
        error.value = err.message ?? err.code ?? '注册失败'
        return
      }
    } else {
      const { error: err } = await useAuthClient().signIn.email({
        email: email.value,
        password: password.value
      })
      if (err) {
        error.value = err.message ?? err.code ?? '登录失败'
        return
      }
    }

    // 登录成功后刷新 session 状态，并直接进入时间线（聚合所有订阅源内容）
    const userStore = useUserStore()
    await userStore.refresh()

    await navigateTo('/timeline')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UContainer class="flex items-center justify-center min-h-[60vh]">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center justify-between">
          <h1 class="text-xl font-bold">
            {{ title }}
          </h1>
          <UButton
            variant="ghost"
            size="sm"
            @click="mode = mode === 'login' ? 'register' : 'login'"
          >
            {{ mode === "login" ? "注册" : "登录" }}
          </UButton>
        </div>
      </template>

      <!-- 开发环境：测试账号快速填入 -->
      <div
        v-if="isDev && mode === 'login'"
        class="px-4 -mt-2 mb-4"
      >
        <p class="text-xs text-gray-500 mb-1">
          测试账号一键填入
        </p>
        <div class="flex gap-2">
          <UButton
            v-for="(acc, i) in TEST_ACCOUNTS"
            :key="i"
            variant="soft"
            size="xs"
            color="primary"
            @click="fillTestAccount(i)"
          >
            {{ acc.label }}
          </UButton>
        </div>
      </div>

      <UForm
        class="space-y-4"
        @submit="handleSubmit"
      >
        <UFormField
          v-if="mode === 'register'"
          label="昵称"
          required
        >
          <UInput
            v-model="name"
            placeholder="你的昵称"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="邮箱"
          required
        >
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="密码"
          required
        >
          <UInput
            v-model="password"
            type="password"
            placeholder="********"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          :icon="false"
        />

        <UButton
          type="submit"
          color="primary"
          :loading="loading"
          class="w-full"
        >
          {{ title }}
        </UButton>
      </UForm>
    </UCard>
  </UContainer>
</template>
