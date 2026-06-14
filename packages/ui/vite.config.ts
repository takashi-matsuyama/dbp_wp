import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// In development the browser UI talks to the CLI server through this proxy, so the
// UI never needs credentials or cross-origin access of its own.
const CLI_PORT = process.env.DBP_WP_CLI_PORT ?? '4317';

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      // Target 127.0.0.1 (not localhost) to match the CLI's IPv4 loopback bind.
      '/api': { target: `http://127.0.0.1:${CLI_PORT}`, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
