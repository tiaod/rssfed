<script setup lang="ts">
import { ref } from 'vue';
import { authClient } from "~~/lib/auth-client";
const session = authClient.useSession();

const email = ref('');
const password = ref('');
const error = ref('');

async function handleEmailLogin() {
  error.value = '';
  try {
    await authClient.signIn.email({ email: email.value, password: password.value });
  } catch (err) {
    console.error('Email login error:', err);
    error.value = '登录失败，请检查邮箱和密码';
  }
}
</script>

<template>
  <div class="container mx-auto p-4">
    <h1 class="text-2xl font-bold mb-4">Auth Test</h1>
    <div v-if="!session?.data">
      <h2 class="text-lg font-semibold mb-4">Sign in with email</h2>
      <div class="space-y-4">
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
          <input 
            id="email" 
            v-model="email" 
            type="email" 
            class="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter your email"
            required
          />
        </div>
        <div>
          <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input 
            id="password" 
            v-model="password" 
            type="password" 
            class="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter your password"
            required
          />
        </div>
        <div v-if="error" class="text-red-500 text-sm">{{ error }}</div>
        <button 
          @click="handleEmailLogin"
          class="w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
        >
          Sign in
        </button>
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