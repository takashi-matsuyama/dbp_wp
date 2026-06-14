<script lang="ts">
  import type { WpPost } from '@dbp-wp/core';
  import { savePosts, type PostUpdate } from '../api';

  let { posts, onsaved }: { posts: WpPost[]; onsaved: () => void | Promise<void> } = $props();

  interface Draft {
    title: string;
    menuOrder: number;
  }

  let drafts = $state<Record<number, Draft>>({});
  let saving = $state(false);
  let error = $state<string | null>(null);
  let rowErrors = $state<Record<number, string>>({});

  function draftFor(post: WpPost): Draft {
    return drafts[post.id] ?? { title: post.title, menuOrder: post.menuOrder };
  }

  function setTitle(post: WpPost, value: string): void {
    drafts[post.id] = { ...draftFor(post), title: value };
  }

  function setMenuOrder(post: WpPost, value: string): void {
    if (value.trim() === '') {
      return; // ignore an empty field rather than coercing it to 0
    }
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      drafts[post.id] = { ...draftFor(post), menuOrder: parsed };
    }
    // else: reject non-integer input instead of silently truncating it
  }

  function isChanged(post: WpPost): boolean {
    const draft = drafts[post.id];
    return draft !== undefined && (draft.title !== post.title || draft.menuOrder !== post.menuOrder);
  }

  const changed = $derived(posts.filter(isChanged));

  function buildUpdates(): PostUpdate[] {
    return changed.map((post) => {
      const draft = draftFor(post);
      const update: PostUpdate = { id: post.id };
      if (draft.title !== post.title) {
        update.title = draft.title;
      }
      if (draft.menuOrder !== post.menuOrder) {
        update.menuOrder = draft.menuOrder;
      }
      return update;
    });
  }

  async function save(): Promise<void> {
    saving = true;
    error = null;
    rowErrors = {};
    try {
      const results = await savePosts(buildUpdates());
      const errors: Record<number, string> = {};
      const succeeded: number[] = [];
      for (const result of results) {
        if (result.ok) {
          succeeded.push(result.id);
        } else {
          errors[result.id] = result.error ?? 'Update failed';
        }
      }
      rowErrors = errors;
      if (succeeded.length > 0) {
        // Drop saved rows' drafts; keep failed rows editable so a retry only resends them.
        const remaining = { ...drafts };
        for (const id of succeeded) {
          delete remaining[id];
        }
        drafts = remaining;
        await onsaved();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

{#if posts.length === 0}
  <p class="empty">No rows yet.</p>
{:else}
  <div class="sheet-toolbar">
    <button onclick={save} disabled={saving || changed.length === 0}>
      {saving ? 'Saving…' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
    </button>
    {#if error}<span class="error">{error}</span>{/if}
  </div>
  <table class="sheet">
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Menu order</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each posts as post (post.id)}
        <tr class:changed={isChanged(post)}>
          <td>{post.id}</td>
          <td>
            <input
              value={draftFor(post).title}
              oninput={(e) => setTitle(post, (e.currentTarget as HTMLInputElement).value)}
            />
          </td>
          <td>
            <input
              type="number"
              value={draftFor(post).menuOrder}
              oninput={(e) => setMenuOrder(post, (e.currentTarget as HTMLInputElement).value)}
            />
          </td>
          <td class="row-status">
            {#if rowErrors[post.id]}<span class="error">{rowErrors[post.id]}</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
