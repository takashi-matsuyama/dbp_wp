<script lang="ts">
  import { onMount } from 'svelte';
  import type { WpPost } from '@dbp-wp/core';
  import { fetchPosts, type PostsResponse } from './lib/api';
  import TableView from './lib/views/TableView.svelte';
  import SpreadsheetView from './lib/views/SpreadsheetView.svelte';

  type Tab = 'table' | 'spreadsheet';

  let tab = $state<Tab>('table');
  let posts = $state<WpPost[]>([]);
  let unconfigured = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res: PostsResponse = await fetchPosts();
      posts = res.posts;
      unconfigured = res.unconfigured;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<header>
  <h1>DBP WP</h1>
  <nav>
    <button class:active={tab === 'table'} onclick={() => (tab = 'table')}>Table</button>
    <button class:active={tab === 'spreadsheet'} onclick={() => (tab = 'spreadsheet')}>
      Spreadsheet
    </button>
  </nav>
</header>

<main>
  {#if loading}
    <p>Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    {#if unconfigured}
      <p class="notice">
        No WordPress connection configured yet. Set credentials to load content.
      </p>
    {/if}
    {#if tab === 'table'}
      <TableView {posts} />
    {:else}
      <SpreadsheetView {posts} />
    {/if}
  {/if}
</main>
