<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

const { data: session } = await authClient.useSession(useFetch)
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col items-center justify-center min-h-[60vh] space-y-6 px-4">
        <template v-if="session">
          <h1 class="text-3xl font-bold">Welcome back, {{ session.user.name }}</h1>
          <p class="text-gray-500 dark:text-gray-400 text-lg">
            Your feeds are ready. Start browsing.
          </p>
          <UButton
            color="primary"
            size="lg"
            to="/feeds"
          >
            Browse Feeds
          </UButton>
        </template>
        <template v-else>
          <UIcon name="i-lucide-rss" class="size-16 text-primary" />
          <h1 class="text-3xl font-bold">RSSFed</h1>
          <p class="text-gray-500 dark:text-gray-400 text-lg text-center max-w-md">
            A modern RSS reader with ActivityPub federation.
            Stay connected with your favorite content.
          </p>
          <div class="flex gap-3">
            <UButton color="primary" size="lg" to="/login">
              Sign In
            </UButton>
            <UButton color="neutral" variant="outline" size="lg" to="/login?register=true">
              Create Account
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
