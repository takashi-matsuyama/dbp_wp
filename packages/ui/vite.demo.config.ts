import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Browser-demo build: the same UI, but the data layer is swapped to the local, network-free
// store (api.local.ts) by defining VITE_DBP_DEMO='true'. Output is a self-contained static
// SPA with relative asset paths (base './') so it can be embedded under any path (e.g. an
// <iframe> on dbp_wp-site). It holds no credentials and makes no requests to WordPress or
// the CLI.
export default defineConfig({
  plugins: [svelte()],
  base: './',
  define: {
    'import.meta.env.VITE_DBP_DEMO': JSON.stringify('true'),
  },
  build: {
    outDir: 'demo-dist',
    emptyOutDir: true,
  },
});
