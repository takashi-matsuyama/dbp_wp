<script lang="ts">
  import type { WpPost } from '@dbp-wp/core';
  import { bulkDeleteMeta, savePosts, type PostUpdate } from '../api';
  import { computeMenuOrders } from '../formula';

  let {
    posts,
    connectorAvailable,
    onsaved,
  }: {
    posts: WpPost[];
    connectorAvailable: boolean;
    onsaved: () => void | Promise<void>;
  } = $props();

  let formula = $state('');
  let formulaError = $state<string | null>(null);

  interface Draft {
    title: string;
    menuOrder: number;
  }

  let drafts = $state<Record<number, Draft>>({});
  // Per-post, per-key string drafts for custom field (meta) edits.
  let metaDrafts = $state<Record<number, Record<string, string>>>({});
  // Meta keys shown as editable columns (full mode only); managed by the user.
  let metaColumns = $state<string[]>([]);
  let newColumn = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let rowErrors = $state<Record<number, string>>({});
  // Bulk meta-delete: the column key awaiting inline confirmation, and in-flight flag.
  let deletingKey = $state<string | null>(null);
  let deleteBusy = $state(false);

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

  // --- Custom field (meta) editing (full mode only) ---

  // Existing meta keys across the loaded posts, excluding protected (`_`-prefixed) keys,
  // offered as suggestions when adding a column. Users may still type a `_` key directly.
  const existingMetaKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const post of posts) {
      const meta = post.dbpWpMeta;
      if (meta) {
        for (const key of Object.keys(meta)) {
          if (!key.startsWith('_')) {
            keys.add(key);
          }
        }
      }
    }
    return [...keys].sort();
  });

  function currentMeta(post: WpPost, key: string): string {
    const value = post.dbpWpMeta?.[key];
    return value === undefined || value === null ? '' : String(value);
  }

  function metaValueFor(post: WpPost, key: string): string {
    return metaDrafts[post.id]?.[key] ?? currentMeta(post, key);
  }

  function setMeta(post: WpPost, key: string, value: string): void {
    metaDrafts[post.id] = { ...metaDrafts[post.id], [key]: value };
  }

  function isMetaChanged(post: WpPost, key: string): boolean {
    const draft = metaDrafts[post.id]?.[key];
    return draft !== undefined && draft !== currentMeta(post, key);
  }

  function addColumn(): void {
    const key = newColumn.trim();
    if (key !== '' && !metaColumns.includes(key)) {
      metaColumns = [...metaColumns, key];
    }
    newColumn = '';
  }

  function removeColumn(key: string): void {
    metaColumns = metaColumns.filter((k) => k !== key);
    // Drop pending drafts for the hidden column so they no longer count as changes.
    const next: Record<number, Record<string, string>> = {};
    for (const [id, row] of Object.entries(metaDrafts)) {
      const rest: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== key) {
          rest[k] = v;
        }
      }
      next[Number(id)] = rest;
    }
    metaDrafts = next;
  }

  // Loaded posts that actually carry this meta key (so deletion has something to do).
  function rowsWithKey(key: string): WpPost[] {
    return posts.filter(
      (post) =>
        post.dbpWpMeta !== undefined &&
        Object.prototype.hasOwnProperty.call(post.dbpWpMeta, key),
    );
  }

  function requestDelete(key: string): void {
    deletingKey = key;
  }

  function cancelDelete(): void {
    deletingKey = null;
  }

  // Delete a meta key from every loaded row that has it (one bulk request).
  async function confirmDelete(key: string): Promise<void> {
    if (deleteBusy || saving) {
      return; // guard against re-entrant triggers
    }
    const targets = rowsWithKey(key);
    if (targets.length === 0) {
      removeColumn(key);
      deletingKey = null;
      return;
    }
    deleteBusy = true;
    error = null;
    try {
      const results = await bulkDeleteMeta(targets.map((post) => ({ id: post.id, keys: [key] })));
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        // Keep the column so its still-present values stay visible next to the error.
        error = `Delete failed for ${failed.length} of ${results.length} row(s).`;
      } else {
        removeColumn(key);
      }
      deletingKey = null;
      await onsaved();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      deleteBusy = false;
    }
  }

  function isChanged(post: WpPost): boolean {
    const draft = drafts[post.id];
    const fieldChanged =
      draft !== undefined && (draft.title !== post.title || draft.menuOrder !== post.menuOrder);
    return fieldChanged || metaColumns.some((key) => isMetaChanged(post, key));
  }

  const changed = $derived(posts.filter(isChanged));

  // Apply a formula to every row's menu_order draft (context: index, id, menuOrder).
  function applyFormula(): void {
    if (formula.trim() === '') {
      return;
    }
    formulaError = null;
    try {
      const values = computeMenuOrders(posts, formula);
      const next = { ...drafts };
      for (const post of posts) {
        const value = values.get(post.id);
        if (value !== undefined) {
          next[post.id] = { ...draftFor(post), menuOrder: value };
        }
      }
      drafts = next;
    } catch (e) {
      formulaError = e instanceof Error ? e.message : String(e);
    }
  }

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
      const meta: Record<string, string> = {};
      for (const key of metaColumns) {
        if (isMetaChanged(post, key)) {
          meta[key] = metaValueFor(post, key);
        }
      }
      if (Object.keys(meta).length > 0) {
        update.meta = meta;
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
        const remainingMeta = { ...metaDrafts };
        for (const id of succeeded) {
          delete remaining[id];
          delete remainingMeta[id];
        }
        drafts = remaining;
        metaDrafts = remainingMeta;
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
    <button onclick={save} disabled={saving || deleteBusy || changed.length === 0}>
      {saving ? 'Saving…' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
    </button>
    {#if error}<span class="error">{error}</span>{/if}
  </div>
  <div class="formula-bar">
    <label>
      menu_order =
      <input
        bind:value={formula}
        placeholder="e.g. index * 10"
        disabled={saving}
        onkeydown={(e) => e.key === 'Enter' && applyFormula()}
      />
    </label>
    <button onclick={applyFormula} disabled={saving || formula.trim() === ''}>
      Apply to all rows
    </button>
    <span class="hint">cells: index, id, menuOrder (saved value)</span>
    {#if formulaError}<span class="error">{formulaError}</span>{/if}
  </div>

  {#if connectorAvailable}
    <div class="meta-bar">
      <label>
        Custom field column
        <input
          list="dbp-meta-keys"
          bind:value={newColumn}
          placeholder="meta key, e.g. price"
          disabled={saving}
          onkeydown={(e) => e.key === 'Enter' && addColumn()}
        />
      </label>
      <datalist id="dbp-meta-keys">
        {#each existingMetaKeys as key (key)}
          <option value={key}></option>
        {/each}
      </datalist>
      <button onclick={addColumn} disabled={saving || newColumn.trim() === ''}>Add column</button>
    </div>
  {:else}
    <p class="restricted-note">
      Custom field editing needs the DBP WP Connector plugin. Standard fields are editable.
    </p>
  {/if}

  <table class="sheet">
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Menu order</th>
        {#each metaColumns as key (key)}
          <th class="meta-col">
            <span class="meta-key">{key}</span>
            {#if deletingKey === key}
              <span class="confirm">
                Delete “{key}” from {rowsWithKey(key).length} row(s)?
                <button onclick={() => confirmDelete(key)} disabled={deleteBusy}>
                  {deleteBusy ? 'Deleting…' : 'Delete'}
                </button>
                <button onclick={cancelDelete} disabled={deleteBusy}>Cancel</button>
              </span>
            {:else}
              <button
                class="col-action"
                title="Hide this column (keeps the data)"
                onclick={() => removeColumn(key)}
                disabled={saving || deleteBusy}>×</button
              >
              <button
                class="col-action danger"
                title="Delete this field from all rows"
                onclick={() => requestDelete(key)}
                disabled={saving || deleteBusy}>🗑</button
              >
            {/if}
          </th>
        {/each}
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
              disabled={saving}
              oninput={(e) => setTitle(post, (e.currentTarget as HTMLInputElement).value)}
            />
          </td>
          <td>
            <input
              type="number"
              value={draftFor(post).menuOrder}
              disabled={saving}
              oninput={(e) => setMenuOrder(post, (e.currentTarget as HTMLInputElement).value)}
            />
          </td>
          {#each metaColumns as key (key)}
            <td class:changed-cell={isMetaChanged(post, key)}>
              <input
                value={metaValueFor(post, key)}
                disabled={saving}
                oninput={(e) => setMeta(post, key, (e.currentTarget as HTMLInputElement).value)}
              />
            </td>
          {/each}
          <td class="row-status">
            {#if rowErrors[post.id]}<span class="error">{rowErrors[post.id]}</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .meta-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .restricted-note {
    margin: 0.5rem 0;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .meta-col {
    white-space: nowrap;
  }
  .col-action {
    margin-left: 0.25rem;
    padding: 0 0.35rem;
    line-height: 1;
    cursor: pointer;
  }
  .col-action.danger {
    color: #b00020;
  }
  .confirm {
    margin-left: 0.5rem;
    font-weight: normal;
    font-size: 0.85rem;
  }
  .changed-cell input {
    background: rgba(255, 215, 0, 0.18);
  }
</style>
