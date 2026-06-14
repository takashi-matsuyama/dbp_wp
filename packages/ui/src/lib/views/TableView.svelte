<script lang="ts">
  import type { SortingState, Updater } from '@tanstack/table-core';
  import type { WpPost } from '@dbp-wp/core';
  import { createPostsTable, headerLabel, sortIndicator } from '../postsTable';

  let { posts }: { posts: WpPost[] } = $props();

  let sorting = $state<SortingState>([]);

  function onSortingChange(updater: Updater<SortingState>): void {
    sorting = typeof updater === 'function' ? updater(sorting) : updater;
  }

  // Rebuild the table when posts or sorting change; table-core is framework-agnostic.
  const table = $derived(createPostsTable({ data: posts, sorting, onSortingChange }));
</script>

{#if posts.length === 0}
  <p class="empty">No posts to show.</p>
{:else}
  <table>
    <thead>
      {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
        <tr>
          {#each headerGroup.headers as header (header.id)}
            <th
              class="sortable"
              onclick={(e) => header.column.getToggleSortingHandler()?.(e)}
            >
              {headerLabel(header)}{sortIndicator(header.column.getIsSorted())}
            </th>
          {/each}
        </tr>
      {/each}
    </thead>
    <tbody>
      {#each table.getRowModel().rows as row (row.id)}
        <tr>
          {#each row.getVisibleCells() as cell (cell.id)}
            <td>{String(cell.getValue() ?? '')}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
