<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

const { data: session } = await authClient.useSession(useFetch)
</script>

<template>
  <div class="min-h-screen flex items-center justify-center">
    <div v-if="session" class="text-center space-y-4">
      <h1 class="text-2xl font-bold">Welcome, {{ session.user.name }}</h1>
      <p class="text-gray-500">Your RSS feeds are ready.</p>
      <UButton @click="authClient.signOut()">Sign Out</UButton>
    </div>
    <div v-else class="text-center space-y-4">
      <h1 class="text-2xl font-bold">RSSFed</h1>
      <p class="text-gray-500">RSS reader with ActivityPub support</p>
      <UButton to="/login">Sign In</UButton>
    </div>
  </div>
</template>