<script setup lang="ts">
import { ref, computed } from "vue"
import { authClient } from "~/lib/auth-client"

const mode = ref<"login" | "register">("login")
const email = ref("")
const password = ref("")
const name = ref("")
const error = ref("")
const loading = ref(false)

const title = computed(() => (mode.value === "login" ? "登录" : "注册"))

async function handleSubmit() {
  error.value = ""
  loading.value = true

  try {
    if (mode.value === "register") {
      const { error: err } = await authClient.signUp.email({
        email: email.value,
        password: password.value,
        name: name.value,
      })
      if (err) {
        error.value = err.message ?? err.code ?? "注册失败"
        return
      }
    } else {
      const { error: err } = await authClient.signIn.email({
        email: email.value,
        password: password.value,
      })
      if (err) {
        error.value = err.message ?? err.code ?? "登录失败"
        return
      }
    }
    await navigateTo("/")
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
          <h1 class="text-xl font-bold">{{ title }}</h1>
          <UButton
            variant="ghost"
            size="sm"
            @click="mode = mode === 'login' ? 'register' : 'login'"
          >
            {{ mode === "login" ? "注册" : "登录" }}
          </UButton>
        </div>
      </template>

      <UForm @submit="handleSubmit" class="space-y-4">
        <UFormField v-if="mode === 'register'" label="昵称" required>
          <UInput v-model="name" placeholder="你的昵称" class="w-full" />
        </UFormField>

        <UFormField label="邮箱" required>
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            class="w-full"
          />
        </UFormField>

        <UFormField label="密码" required>
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
