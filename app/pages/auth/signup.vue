<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import { authClient } from '~~/lib/auth-client'

useHead({
  title: '注册 - RSSFed'
})

const router = useRouter()

const form = reactive({
  name: '',
  email: '',
  password: '',
  confirmPassword: ''
})

const errors = reactive({
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  general: ''
})

const isLoading = ref(false)
const showPassword = ref(false)
const showConfirmPassword = ref(false)

const passwordStrength = computed(() => {
  const password = form.password
  let strength = 0
  const checks = {
    length: password.length >= 8,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /\d/.test(password),
    special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
  }

  strength = Object.values(checks).filter(Boolean).length

  return {
    score: strength,
    checks,
    text: strength <= 2 ? '弱' : strength <= 3 ? '中' : '强',
    color: strength <= 2 ? 'error' : strength <= 3 ? 'warning' : 'success'
  }
})

const validateForm = (): boolean => {
  let isValid = true
  errors.name = ''
  errors.email = ''
  errors.password = ''
  errors.confirmPassword = ''
  errors.general = ''

  if (!form.name.trim()) {
    errors.name = '请输入用户名'
    isValid = false
  } else if (form.name.length < 2) {
    errors.name = '用户名至少需要2个字符'
    isValid = false
  } else if (form.name.length > 20) {
    errors.name = '用户名不能超过20个字符'
    isValid = false
  }

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

  if (!form.confirmPassword) {
    errors.confirmPassword = '请确认密码'
    isValid = false
  } else if (form.password !== form.confirmPassword) {
    errors.confirmPassword = '两次输入的密码不一致'
    isValid = false
  }

  return isValid
}

const handleSignup = async () => {
  if (!validateForm()) return

  isLoading.value = true
  errors.general = ''

  try {
    const { data, error } = await authClient.signUp.email({
      email: form.email,
      password: form.password,
      name: form.name
    })

    if (error) {
      if (error.message?.includes('email')) {
        errors.email = '该邮箱已被注册'
      } else {
        errors.general = error.message || '注册失败，请稍后重试'
      }
      return
    }

    if (data) {
      await router.push('/')
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : '注册过程中发生错误，请稍后重试'
    errors.general = errorMessage
  } finally {
    isLoading.value = false
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    handleSignup()
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-200px)] flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
    <UCard class="w-full max-w-md">
      <div class="text-center mb-8">
        <h2 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          创建账户
        </h2>
        <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">
          填写以下信息开始您的旅程
        </p>
      </div>

      <UForm
        :state="form"
        class="space-y-5"
        @submit="handleSignup"
      >
        <UFormField
          label="用户名"
          name="name"
          :error="errors.name"
          required
        >
          <UInput
            v-model="form.name"
            type="text"
            placeholder="请输入用户名"
            icon="i-lucide-user"
            size="lg"
            class="w-full"
            :disabled="isLoading"
            @keydown="handleKeydown"
          />
        </UFormField>

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

        <div
          v-if="form.password"
          class="space-y-2"
        >
          <div class="flex items-center justify-between text-xs">
            <span class="text-gray-600 dark:text-gray-400">密码强度</span>
            <span :class="`text-${passwordStrength.color}-500`">{{ passwordStrength.text }}</span>
          </div>
          <div class="flex gap-1">
            <div
              v-for="i in 5"
              :key="i"
              class="h-1 flex-1 rounded-full transition-colors duration-300"
              :class="i <= passwordStrength.score ? `bg-${passwordStrength.color}-500` : 'bg-gray-200 dark:bg-gray-700'"
            />
          </div>
          <ul class="text-xs text-gray-500 dark:text-gray-400 space-y-1 mt-2">
            <li :class="passwordStrength.checks.length ? 'text-success-500' : ''">
              <UIcon
                :name="passwordStrength.checks.length ? 'i-lucide-check' : 'i-lucide-x'"
                class="w-3 h-3 inline mr-1"
              />
              至少8个字符
            </li>
            <li :class="passwordStrength.checks.lowercase ? 'text-success-500' : ''">
              <UIcon
                :name="passwordStrength.checks.lowercase ? 'i-lucide-check' : 'i-lucide-x'"
                class="w-3 h-3 inline mr-1"
              />
              包含小写字母
            </li>
            <li :class="passwordStrength.checks.uppercase ? 'text-success-500' : ''">
              <UIcon
                :name="passwordStrength.checks.uppercase ? 'i-lucide-check' : 'i-lucide-x'"
                class="w-3 h-3 inline mr-1"
              />
              包含大写字母
            </li>
            <li :class="passwordStrength.checks.number ? 'text-success-500' : ''">
              <UIcon
                :name="passwordStrength.checks.number ? 'i-lucide-check' : 'i-lucide-x'"
                class="w-3 h-3 inline mr-1"
              />
              包含数字
            </li>
            <li :class="passwordStrength.checks.special ? 'text-success-500' : ''">
              <UIcon
                :name="passwordStrength.checks.special ? 'i-lucide-check' : 'i-lucide-x'"
                class="w-3 h-3 inline mr-1"
              />
              包含特殊字符
            </li>
          </ul>
        </div>

        <UFormField
          label="确认密码"
          name="confirmPassword"
          :error="errors.confirmPassword"
          required
        >
          <UInput
            v-model="form.confirmPassword"
            :type="showConfirmPassword ? 'text' : 'password'"
            placeholder="请再次输入密码"
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
                :icon="showConfirmPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                @click="showConfirmPassword = !showConfirmPassword"
              />
            </template>
          </UInput>
        </UFormField>

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
          {{ isLoading ? '注册中...' : '创建账户' }}
        </UButton>

        <p class="text-xs text-center text-gray-500 dark:text-gray-400">
          点击"创建账户"即表示您同意我们的
          <UButton
            to="/terms"
            variant="link"
            size="xs"
            class="p-0"
          >
            服务条款
          </UButton>
          和
          <UButton
            to="/privacy"
            variant="link"
            size="xs"
            class="p-0"
          >
            隐私政策
          </UButton>
        </p>
      </UForm>

      <div class="mt-6">
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <div class="w-full border-t border-gray-200 dark:border-gray-700" />
          </div>
          <div class="relative flex justify-center text-sm">
            <span class="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
              已有账户？
            </span>
          </div>
        </div>

        <div class="mt-6">
          <UButton
            to="/auth/login"
            color="neutral"
            variant="outline"
            size="lg"
            block
          >
            直接登录
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
