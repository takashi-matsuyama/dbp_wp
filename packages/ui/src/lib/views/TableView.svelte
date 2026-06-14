<script lang="ts">
  import type { WpPost } from '@dbp-wp/core';

  let { posts }: { posts: WpPost[] } = $props();
</script>

{#if posts.length === 0}
  <p class="empty">No posts to show.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Status</th>
        <th>Menu order</th>
      </tr>
    </thead>
    <tbody>
      {#each posts as post (post.id)}
        <tr>
          <td>{post.id}</td>
          <td>{post.title}</td>
          <td>{post.status}</td>
          <td>{post.menuOrder}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
