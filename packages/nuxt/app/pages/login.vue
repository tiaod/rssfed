<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

const email = ref("")
const password = ref("")
const name = ref("")
const isRegister = ref(false)

async function handleSubmit() {
  if (isRegister.value) {
    await authClient.signUp.email({ name: name.value, email: email.value, password: password.value })
  } else {
    await authClient.signIn.email({ email: email.value, password: password.value })
  }
  await navigateTo("/")
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center">
    <UCard class="w-full max-w-sm">
      <template #header>
        <h2 class="text-xl font-semibold text-center">
          {{ isRegister ? "Create Account" : "Sign In" }}
        </h2>
      </template>

      <form @submit.prevent="handleSubmit" class="space-y-4">
        <UInput v-if="isRegister" v-model="name" type="text" placeholder="Name" required />
        <UInput v-model="email" type="email" placeholder="Email" required />
        <UInput v-model="password" type="password" placeholder="Password" required />
        <UButton type="submit" class="w-full">
          {{ isRegister ? "Register" : "Sign In" }}
        </UButton>
      </form>

      <template #footer>
        <p class="text-sm text-center text-gray-500">
          {{ isRegister ? "Already have an account?" : "Don't have an account?" }}
          <ULink @click="isRegister = !isRegister" class="cursor-pointer text-primary">
            {{ isRegister ? "Sign In" : "Register" }}
          </ULink>
        </p>
      </template>
    </UCard>
  </div>
</template>
