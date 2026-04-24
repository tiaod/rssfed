<script setup lang="ts">
definePageMeta({
  title: '文章 - RSSFed'
})

const route = useRoute()
const feedId = route.query.feed as string | undefined

// 兼容旧的 /entries?feed=X 链接，重定向到新的 /feed/X 路径
if (feedId) {
  await navigateTo(`/feed/${feedId}`, { redirectCode: 301, replace: true })
} else {
  await navigateTo('/', { redirectCode: 301, replace: true })
}
</script>
