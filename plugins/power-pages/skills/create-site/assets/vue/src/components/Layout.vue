<template>
  <div class="app">
    <header class="header">
      <nav class="nav">
        <RouterLink to="/" class="logo">__SITE_NAME__</RouterLink>
        <div class="nav-links">
          <RouterLink to="/" :class="{ active: route.path === '/' }">Home</RouterLink>
          <RouterLink to="/about" :class="{ active: route.path === '/about' }">About</RouterLink>
        </div>
      </nav>
    </header>
    <main class="main">
      <slot />
    </main>
    <footer class="footer">
      <p>&copy; {{ year }} __SITE_NAME__</p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
const year = new Date().getFullYear()
</script>
