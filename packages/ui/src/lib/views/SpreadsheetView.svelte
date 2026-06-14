<script lang="ts">
  import type { WpPost } from '@dbp-wp/core';

  let { posts }: { posts: WpPost[] } = $props();

  // Skeleton: title edits are kept as local drafts only. Persisting changes back to
  // WordPress and the formula engine are wired in a later implementation step.
  let drafts = $state<Record<number, string>>({});

  function titleOf(post: WpPost): string {
    return drafts[post.id] ?? post.title;
  }

  function onEdit(id: number, event: Event): void {
    drafts[id] = (event.currentTarget as HTMLInputElement).value;
  }
</script>

{#if posts.length === 0}
  <p class="empty">No rows yet.</p>
{:else}
  <table class="sheet">
    <thead>
      <tr>
        <th>ID</th>
        <th>Title (editable draft)</th>
        <th>Menu order</th>
      </tr>
    </thead>
    <tbody>
      {#each posts as post (post.id)}
        <tr>
          <td>{post.id}</td>
          <td>
            <input value={titleOf(post)} oninput={(e) => onEdit(post.id, e)} />
          </td>
          <td>{post.menuOrder}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="notice">Edits are local drafts only (save + formulas come later).</p>
{/if}
