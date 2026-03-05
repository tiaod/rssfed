<script setup lang="ts">
import { authClient } from "~~/lib/auth-client";
const session = authClient.useSession();
</script>

<template>
  <div class="container mx-auto p-4">
    <h1 class="text-2xl font-bold mb-4">Auth Test</h1>
    <div v-if="!session?.data">
      <button 
        @click="() => authClient.signIn.social({ provider: 'github' })"
        class="bg-gray-800 text-white px-4 py-2 rounded-md hover:bg-gray-700"
      >
        Continue with GitHub
      </button>
      <div class="mt-4">
        <h2 class="text-lg font-semibold">or sign in with email</h2>
        <!-- 这里可以添加邮箱登录表单 -->
      </div>
    </div>
    <div v-else>
      <h2 class="text-lg font-semibold">Welcome!</h2>
      <pre class="mt-4 p-4 bg-gray-100 rounded-md">{{ session.data }}</pre>
      <button 
        @click="authClient.signOut()"
        class="mt-4 bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600"
      >
        Sign out
      </button>
    </div>
  </div>
</template>