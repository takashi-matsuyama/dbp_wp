<script lang="ts">
  import { onMount } from 'svelte';
  import type { WpPost, WpPostType } from '@dbp-wp/core';
  import {
    disconnect,
    fetchPosts,
    fetchTypes,
    getConnection,
    type ConnectionStatus,
  } from './lib/api';
  import ConnectionPanel from './lib/views/ConnectionPanel.svelte';
  import TableView from './lib/views/TableView.svelte';
  import SpreadsheetView from './lib/views/SpreadsheetView.svelte';
  import ImportView from './lib/views/ImportView.svelte';
  import PrintView from './lib/views/PrintView.svelte';

  type Tab = 'table' | 'spreadsheet' | 'import' | 'print';

  let tab = $state<Tab>('table');
  let connection = $state<ConnectionStatus>({ connected: false, siteUrl: null, connectorAvailable: false });
  let posts = $state<WpPost[]>([]);
  let postTypes = $state<WpPostType[]>([]);
  let selectedType = $state('posts');
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      connection = await getConnection();
      if (connection.connected) {
        if (postTypes.length === 0) {
          try {
            postTypes = await fetchTypes();
          } catch {
            // Non-fatal: the type selector just stays hidden, defaulting to posts.
          }
        }
        const res = await fetchPosts({ type: selectedType });
        if (res.unconfigured) {
          // Credentials disappeared between the checks; reflect the real state.
          connection = { connected: false, siteUrl: null, connectorAvailable: false };
          posts = [];
          postTypes = [];
          selectedType = 'posts';
        } else {
          posts = res.posts;
        }
      } else {
        posts = [];
        postTypes = [];
        selectedType = 'posts';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function changeType(next: string): Promise<void> {
    if (next === selectedType) {
      return;
    }
    selectedType = next;
    await refresh();
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
      <button class:active={tab === 'import'} onclick={() => (tab = 'import')}>Import</button>
      <button class:active={tab === 'print'} onclick={() => (tab = 'print')}>Print</button>
    </nav>
    {#if postTypes.length > 0}
      <label class="type-select">
        Type
        <select
          value={selectedType}
          disabled={loading}
          onchange={(e) => changeType((e.currentTarget as HTMLSelectElement).value)}
        >
          {#each postTypes as pt (pt.restBase)}
            <option value={pt.restBase}>{pt.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <span class="conn">
      {connection.siteUrl}
      <span class="connector-badge" class:restricted={!connection.connectorAvailable}>
        {connection.connectorAvailable ? 'Connector: active' : 'Restricted mode'}
      </span>
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
  {:else if tab === 'spreadsheet'}
    {#key `${connection.siteUrl ?? ''}:${selectedType}`}
      <SpreadsheetView
        {posts}
        type={selectedType}
        siteUrl={connection.siteUrl}
        connectorAvailable={connection.connectorAvailable}
        {postTypes}
        onsaved={refresh}
      />
    {/key}
  {:else if tab === 'import'}
    {#key selectedType}
      <ImportView
        type={selectedType}
        connectorAvailable={connection.connectorAvailable}
        onimported={refresh}
      />
    {/key}
  {:else}
    {#key selectedType}
      <PrintView type={selectedType} connectorAvailable={connection.connectorAvailable} />
    {/key}
  {/if}
</main>
