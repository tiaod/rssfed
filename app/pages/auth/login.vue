<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { authClient } from '~/lib/auth-client'

useHead({
  title: '登录 - RSSFed'
})

const router = useRouter()

const isDev = computed(() => import.meta.dev)

const form = reactive({
  email: '',
  password: ''
})

onMounted(() => {
  if (isDev.value) {
    form.email = 'admin@example.com'
    form.password = 'Admin123!'
  }
})

const errors = reactive({
  email: '',
  password: '',
  general: ''
})

const isLoading = ref(false)
const showPassword = ref(false)

const validateForm = (): boolean => {
  let isValid = true
  errors.email = ''
  errors.password = ''
  errors.general = ''

  if (!form.email.trim()) {
    errors.email = '请输入邮箱地址'
    isValid = false
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.email = '请输入有效的邮箱地址'
    isValid = false
  }

  if (!form.password) {
    errors.password = '请输入密码'
    isValid = false
  } else if (form.password.length < 6) {
    errors.password = '密码至少需要6个字符'
    isValid = false
  }

  return isValid
}

const handleLogin = async () => {
  if (!validateForm()) return

  isLoading.value = true
  errors.general = ''

  try {
    const { data, error } = await authClient.signIn.email({
      email: form.email,
      password: form.password
    })

    if (error) {
      errors.general = error.message || '登录失败，请检查邮箱和密码'
      return
    }

    if (data) {
      await router.push('/')
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : '登录过程中发生错误，请稍后重试'
    errors.general = errorMessage
  } finally {
    isLoading.value = false
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    handleLogin()
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-200px)] flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
    <UCard class="w-full max-w-md">
      <div class="text-center mb-8">
        <h2 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          欢迎回来
        </h2>
        <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">
          登录您的账户以继续
        </p>
        <ClientOnly>
          <div v-if="isDev" class="mt-4">
            <UBadge color="primary" variant="soft">
              开发环境 - 测试账号已自动填充
            </UBadge>
          </div>
        </ClientOnly>
      </div>

      <ClientOnly>
        <UForm
          :state="form"
          class="space-y-6"
          @submit="handleLogin"
        >
        <UFormField
          label="邮箱地址"
          name="email"
          :error="errors.email"
          required
        >
          <UInput
            v-model="form.email"
            type="email"
            placeholder="your@email.com"
            icon="i-lucide-mail"
            size="lg"
            class="w-full"
            :disabled="isLoading"
            @keydown="handleKeydown"
          />
        </UFormField>

        <UFormField
          label="密码"
          name="password"
          :error="errors.password"
          required
        >
          <UInput
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="请输入密码"
            icon="i-lucide-lock"
            size="lg"
            class="w-full"
            :disabled="isLoading"
            @keydown="handleKeydown"
          >
            <template #trailing>
              <UButton
                color="neutral"
                variant="link"
                size="sm"
                :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                @click="showPassword = !showPassword"
              />
            </template>
          </UInput>
        </UFormField>

        <div class="flex items-center justify-between">
          <UCheckbox
            label="记住我"
            name="remember"
          />
          <UButton
            to="/auth/forgot-password"
            variant="link"
            color="primary"
            size="sm"
            class="p-0"
          >
            忘记密码？
          </UButton>
        </div>

        <UAlert
          v-if="errors.general"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :title="errors.general"
          class="mb-4"
        />

        <UButton
          type="submit"
          color="primary"
          size="lg"
          block
          :loading="isLoading"
          :disabled="isLoading"
        >
          {{ isLoading ? '登录中...' : '登录' }}
        </UButton>
        </UForm>
      </ClientOnly>

      <div class="mt-6">
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <div class="w-full border-t border-gray-200 dark:border-gray-700" />
          </div>
          <div class="relative flex justify-center text-sm">
            <span class="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
              还没有账户？
            </span>
          </div>
        </div>

        <div class="mt-6">
          <UButton
            to="/auth/signup"
            color="neutral"
            variant="outline"
            size="lg"
            block
          >
            创建新账户
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
