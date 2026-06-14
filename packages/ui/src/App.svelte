<script lang="ts">
  import { onMount } from 'svelte';
  import type { WpPost } from '@dbp-wp/core';
  import { disconnect, fetchPosts, getConnection, type ConnectionStatus } from './lib/api';
  import ConnectionPanel from './lib/views/ConnectionPanel.svelte';
  import TableView from './lib/views/TableView.svelte';
  import SpreadsheetView from './lib/views/SpreadsheetView.svelte';

  type Tab = 'table' | 'spreadsheet';

  let tab = $state<Tab>('table');
  let connection = $state<ConnectionStatus>({ connected: false, siteUrl: null });
  let posts = $state<WpPost[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      connection = await getConnection();
      if (connection.connected) {
        const res = await fetchPosts();
        if (res.unconfigured) {
          // Credentials disappeared between the checks; reflect the real state.
          connection = { connected: false, siteUrl: null };
          posts = [];
        } else {
          posts = res.posts;
        }
      } else {
        posts = [];
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function onDisconnect(): Promise<void> {
    try {
      await disconnect();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await refresh();
  }

  onMount(() => {
    void refresh();
  });
</script>

<header>
  <h1>DBP WP</h1>
  {#if connection.connected}
    <nav>
      <button class:active={tab === 'table'} onclick={() => (tab = 'table')}>Table</button>
      <button class:active={tab === 'spreadsheet'} onclick={() => (tab = 'spreadsheet')}>
        Spreadsheet
      </button>
    </nav>
    <span class="conn">
      {connection.siteUrl}
      <button onclick={onDisconnect}>Disconnect</button>
    </span>
  {/if}
</header>

<main>
  {#if loading}
    <p>Loading…</p>
  {:else if error}
    <p class="error">{error}</p>
    <button onclick={refresh}>Retry</button>
  {:else if !connection.connected}
    <ConnectionPanel onconnected={refresh} />
  {:else if tab === 'table'}
    <TableView {posts} />
  {:else}
    <SpreadsheetView {posts} />
  {/if}
</main>
