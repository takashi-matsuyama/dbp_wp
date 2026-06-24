<script lang="ts">
  import type { WpTaxonomy, WpTerm } from '@dbp-wp/core';
  import { fetchTaxonomies, fetchAllTerms, createTerm, updateTerm, deleteTerm, mergeTerm } from '../api';
  import { flattenTermTree } from '../termTree';

  // The taxonomy manager is scoped to the currently selected post type's taxonomies (consistent
  // with the rest of the app). It governs term lifecycle (rename / reparent / delete) — the
  // separate concern from assigning terms to a post, which stays in the spreadsheet picker.
  // `onchanged` lets the app refresh its post cache after a destructive change (a deleted term
  // must not linger in the spreadsheet's assignments where it could be re-saved).
  let { type, onchanged }: { type: string; onchanged?: () => void } = $props();

  let taxonomies = $state<WpTaxonomy[]>([]);
  let selectedTax = $state('');
  let terms = $state<WpTerm[]>([]);
  let truncated = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let filter = $state('');
  let busy = $state(false);

  // New-term form.
  let newName = $state('');
  let newParent = $state(0);

  // Per-row edit / delete / merge state (only one row at a time).
  let editingId = $state<number | null>(null);
  let editName = $state('');
  let editParent = $state(0);
  let deletingId = $state<number | null>(null);
  let mergingId = $state<number | null>(null);
  let mergeTarget = $state(0);
  // Lingering note when a merge could not delete the source (partial failure, truncation, cancel).
  let mergeNote = $state<string | null>(null);
  // Live progress while a merge runs (null when idle); paired with an AbortController for Cancel.
  let mergeProgress = $state<{ reassigned: number; failed: number; total: number } | null>(null);
  let mergeAbort = $state<AbortController | null>(null);

  const rows = $derived(flattenTermTree(terms, filter));
  // The full tree, ignoring the filter — used to populate the merge target list so a typed filter
  // can never hide a valid target term.
  const treeRows = $derived(flattenTermTree(terms, ''));
  const currentTax = $derived(taxonomies.find((t) => t.restBase === selectedTax) ?? null);
  // Only hierarchical taxonomies have parents; a flat taxonomy (e.g. tags) hides all parent UI.
  const isHierarchical = $derived(currentTax?.hierarchical ?? false);
  // When a hierarchical tree is truncated, child terms beyond the cap are not loaded, so
  // `hasChildren` cannot be trusted — block merge (which must reject a term with children) until
  // the full tree is available. A flat taxonomy has no children, so truncation is harmless there.
  const mergeBlockedByTruncation = $derived(isHierarchical && truncated);

  // Monotonic token so a slow load for a previously-selected taxonomy can't overwrite a newer one.
  let loadToken = 0;

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function loadTaxonomies(): Promise<void> {
    loading = true;
    error = null;
    resetRowState();
    terms = [];
    truncated = false;
    try {
      const list = await fetchTaxonomies(type);
      taxonomies = list;
      // Prefer a hierarchical taxonomy (the tree is most useful there), else the first.
      selectedTax = (list.find((t) => t.hierarchical) ?? list[0])?.restBase ?? '';
      if (selectedTax) {
        await loadTerms();
      } else {
        terms = [];
        truncated = false;
      }
    } catch (e) {
      error = msg(e);
    } finally {
      loading = false;
    }
  }

  async function loadTerms(): Promise<void> {
    if (!selectedTax) return;
    const token = ++loadToken;
    const tax = selectedTax;
    loading = true;
    error = null;
    try {
      const res = await fetchAllTerms(tax);
      if (token !== loadToken) return; // a newer load (or taxonomy switch) superseded this one
      terms = res.items;
      truncated = res.truncated;
    } catch (e) {
      if (token === loadToken) error = msg(e);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  function resetRowState(): void {
    editingId = null;
    deletingId = null;
    mergingId = null;
    mergeProgress = null;
  }

  /** Whether a term has child terms — a merge is blocked for those (WordPress would reparent the
   *  children on delete, an unexpected hierarchy change). */
  function hasChildren(id: number): boolean {
    return terms.some((t) => t.parent === id);
  }

  async function onChangeTax(): Promise<void> {
    resetRowState();
    filter = '';
    newParent = 0;
    terms = [];
    truncated = false;
    await loadTerms();
  }

  async function onCreate(): Promise<void> {
    const name = newName.trim();
    if (name === '' || selectedTax === '' || busy) return;
    busy = true;
    error = null;
    try {
      await createTerm(selectedTax, newParent > 0 ? { name, parent: newParent } : { name });
      newName = '';
      newParent = 0;
      await loadTerms();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  function startEdit(t: WpTerm): void {
    deletingId = null;
    editingId = t.id;
    editName = t.name;
    editParent = t.parent;
  }

  async function saveEdit(t: WpTerm): Promise<void> {
    const name = editName.trim();
    if (name === '' || busy) return;
    const input: { name?: string; parent?: number } = {};
    if (name !== t.name) input.name = name;
    if (editParent !== t.parent) input.parent = editParent;
    if (Object.keys(input).length === 0) {
      editingId = null;
      return;
    }
    busy = true;
    error = null;
    try {
      await updateTerm(selectedTax, t.id, input);
      editingId = null;
      await loadTerms();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  async function confirmDelete(t: WpTerm): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await deleteTerm(selectedTax, t.id);
      deletingId = null;
      await loadTerms();
      // A deleted term may have been assigned to posts; refresh the app's post cache so the
      // spreadsheet picker can't re-save the now-removed id.
      onchanged?.();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = false;
    }
  }

  function startMerge(t: WpTerm): void {
    if (mergeBlockedByTruncation) return;
    editingId = null;
    deletingId = null;
    mergeNote = null;
    mergingId = t.id;
    mergeTarget = 0;
  }

  async function confirmMerge(t: WpTerm): Promise<void> {
    if (busy || mergeTarget <= 0 || mergeTarget === t.id) return;
    busy = true;
    error = null;
    mergeNote = null;
    const name = t.name;
    const controller = new AbortController();
    mergeAbort = controller;
    mergeProgress = { reassigned: 0, failed: 0, total: 0 };
    let caught: string | null = null;
    let canceledByUser = false;
    let result: Awaited<ReturnType<typeof mergeTerm>> | null = null;
    try {
      result = await mergeTerm(selectedTax, t.id, mergeTarget, {
        signal: controller.signal,
        onProgress: (p) => (mergeProgress = p),
      });
      mergingId = null;
    } catch (e) {
      // A user Cancel aborts the fetch — surface that as a cancellation, not an error.
      if (controller.signal.aborted) canceledByUser = true;
      else caught = msg(e);
    }
    const lastReassigned = result?.reassigned ?? mergeProgress?.reassigned ?? 0;
    mergeAbort = null;
    mergeProgress = null;
    // Re-assignments may have already happened even when the call threw or was canceled. Always
    // refresh so the term list and the app's post cache reflect reality, then report the outcome
    // (loadTerms clears `error`, so set it afterwards).
    try {
      await loadTerms();
    } catch {
      /* a load failure is surfaced below by `caught` if present, else the next reload */
    }
    onchanged?.();
    if (result?.canceled) {
      // The data layer confirmed it stopped and kept the source (e.g. the demo's cooperative abort).
      mergingId = null;
      mergeNote = `Merge canceled — re-assigned ${result.reassigned} post(s); "${name}" was kept.`;
    } else if (canceledByUser) {
      // The fetch was aborted before a final result arrived, so the exact server state is unknown;
      // the refreshed list above reflects the truth. Stay neutral rather than assert "kept".
      mergingId = null;
      mergeNote = `Merge canceled — re-assigned about ${lastReassigned} post(s). The list has been refreshed.`;
    } else if (caught) {
      error = caught;
    } else if (result && !result.deleted) {
      // The source was kept because the merge could not be guaranteed complete.
      mergeNote =
        result.failed.length > 0
          ? `Re-assigned ${result.reassigned} post(s), but ${result.failed.length} failed. "${name}" was kept — re-run the merge to finish.`
          : `Re-assigned ${result.reassigned} post(s). This taxonomy is too large or spans a post type not available over REST, so "${name}" was kept — re-run the merge to finish.`;
    }
    busy = false;
  }

  // Reload whenever the selected post type changes (and on first mount).
  let lastType = '';
  $effect(() => {
    if (type !== lastType) {
      lastType = type;
      void loadTaxonomies();
    }
  });
</script>

<section class="tax-manage">
  <header class="tm-head">
    <h2>Taxonomy management</h2>
    <p class="sub">Rename, re-parent, or delete terms. Assigning terms to posts stays in the spreadsheet.</p>
  </header>

  {#if loading && terms.length === 0}
    <p>Loading…</p>
  {:else if taxonomies.length === 0}
    <p class="hint">This post type has no editable taxonomies.</p>
  {:else}
    <div class="tm-tools">
      {#if taxonomies.length > 1}
        <label>
          Taxonomy
          <select bind:value={selectedTax} disabled={busy} onchange={onChangeTax}>
            {#each taxonomies as tax (tax.restBase)}
              <option value={tax.restBase}>{tax.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      <input
        type="search"
        placeholder="Filter terms…"
        bind:value={filter}
        disabled={busy}
        aria-label="Filter terms"
      />
    </div>

    <form class="tm-create" onsubmit={(e) => { e.preventDefault(); void onCreate(); }}>
      <input
        type="text"
        placeholder="New term name"
        aria-label="New term name"
        bind:value={newName}
        disabled={busy}
      />
      {#if isHierarchical}
        <select bind:value={newParent} disabled={busy} aria-label="Parent term">
          <option value={0}>(top level)</option>
          {#each rows as r (r.term.id)}
            <option value={r.term.id}>{'— '.repeat(r.depth)}{r.term.name}</option>
          {/each}
        </select>
      {/if}
      <button type="submit" disabled={busy || newName.trim() === ''}>Add term</button>
    </form>

    {#if error}<p class="error">{error}</p>{/if}
    {#if mergeNote}<p class="hint merge-note">{mergeNote}</p>{/if}
    {#if truncated}
      <p class="hint">
        Showing the first terms only; this taxonomy is very large.{#if isHierarchical} Merge is unavailable until the full tree loads (child terms can't be confirmed).{/if}
      </p>
    {/if}

    {#if rows.length === 0}
      <p class="hint">No terms{filter.trim() ? ' match the filter' : ''}.</p>
    {:else}
      <ul class="term-list">
        {#each rows as r (r.term.id)}
          <li style="padding-left: {filter.trim() ? 0 : r.depth * 1.25}rem">
            {#if editingId === r.term.id}
              <div class="term-edit">
                <input type="text" bind:value={editName} disabled={busy} aria-label="Term name" />
                {#if isHierarchical}
                  <select bind:value={editParent} disabled={busy} aria-label="Parent term">
                    <option value={0}>(top level)</option>
                    {#each rows as o (o.term.id)}
                      {#if o.term.id !== r.term.id}
                        <option value={o.term.id}>{'— '.repeat(o.depth)}{o.term.name}</option>
                      {/if}
                    {/each}
                  </select>
                {/if}
                <button type="button" class="primary" disabled={busy || editName.trim() === ''} onclick={() => saveEdit(r.term)}>Save</button>
                <button type="button" disabled={busy} onclick={() => (editingId = null)}>Cancel</button>
              </div>
            {:else if deletingId === r.term.id}
              <div class="term-delete">
                <span>
                  Delete <strong>{r.term.name}</strong>?
                  {#if r.term.count > 0}
                    It is assigned to {r.term.count} post{r.term.count === 1 ? '' : 's'} (the assignment is removed).
                  {/if}
                  Child terms move up to its parent.
                </span>
                <button type="button" class="danger" disabled={busy} onclick={() => confirmDelete(r.term)}>Delete</button>
                <button type="button" disabled={busy} onclick={() => (deletingId = null)}>Cancel</button>
              </div>
            {:else if mergingId === r.term.id}
              <div class="term-merge">
                {#if mergeProgress}
                  <span class="merge-into">
                    Merging… {mergeProgress.reassigned}{mergeProgress.total ? ` / ${mergeProgress.total}` : ''}
                    {#if mergeProgress.failed > 0}({mergeProgress.failed} failed){/if}
                  </span>
                  {#if mergeProgress.total}
                    <progress max={mergeProgress.total} value={mergeProgress.reassigned + mergeProgress.failed}></progress>
                  {:else}
                    <progress></progress>
                  {/if}
                  <button type="button" class="danger" disabled={!mergeAbort} onclick={() => mergeAbort?.abort()}>Cancel</button>
                {:else if hasChildren(r.term.id)}
                  <span>
                    <strong>{r.term.name}</strong> has child terms. Re-parent or delete them first, then merge.
                  </span>
                  <button type="button" disabled={busy} onclick={() => (mergingId = null)}>Cancel</button>
                {:else}
                  <span class="merge-into">
                    Merge <strong>{r.term.name}</strong> into
                    <select bind:value={mergeTarget} disabled={busy} aria-label="Merge target term">
                      <option value={0}>(select a term)</option>
                      {#each treeRows as o (o.term.id)}
                        {#if o.term.id !== r.term.id}
                          <option value={o.term.id}>{'— '.repeat(o.depth)}{o.term.name}</option>
                        {/if}
                      {/each}
                    </select>
                  </span>
                  <span class="hint">
                    {#if r.term.count > 0}
                      Its {r.term.count} post{r.term.count === 1 ? '' : 's'} move to the target across all post types, then it is deleted. This cannot be undone.
                    {:else}
                      It has no assigned posts; merging just deletes it. This cannot be undone.
                    {/if}
                  </span>
                  <button type="button" class="primary" disabled={busy || mergeTarget <= 0} onclick={() => confirmMerge(r.term)}>Merge</button>
                  <button type="button" disabled={busy} onclick={() => (mergingId = null)}>Cancel</button>
                {/if}
              </div>
            {:else}
              <div class="term-row">
                <span class="term-name">{r.term.name}</span>
                <span class="term-count" title="Posts assigned">{r.term.count}</span>
                <span class="term-actions">
                  <button type="button" disabled={busy || loading} onclick={() => startEdit(r.term)}>Edit</button>
                  <button
                    type="button"
                    disabled={busy || loading || mergeBlockedByTruncation}
                    title={mergeBlockedByTruncation ? 'Merge is unavailable while the term tree is incomplete (too large to load fully).' : undefined}
                    onclick={() => startMerge(r.term)}
                  >Merge</button>
                  <button type="button" disabled={busy || loading} onclick={() => { editingId = null; mergingId = null; deletingId = r.term.id; }}>Delete</button>
                </span>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .tax-manage {
    max-width: 48rem;
  }
  .tm-head h2 {
    margin: 0 0 0.15rem;
    font-size: 1.1rem;
  }
  .sub {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .tm-tools,
  .tm-create {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
  }
  .tm-tools label {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .tm-create {
    border-top: 1px solid #eee;
    padding-top: 0.6rem;
  }
  .term-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid #eee;
  }
  .term-list li {
    border-bottom: 1px solid #eee;
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
  }
  .term-row,
  .term-edit,
  .term-delete,
  .term-merge {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  /* The merge panel carries more controls (select + impact + actions); let it wrap on narrow widths. */
  .term-merge {
    flex-wrap: wrap;
  }
  .term-name {
    flex: 1 1 auto;
    min-width: 0;
  }
  .term-count {
    min-width: 1.6rem;
    text-align: right;
    font-size: 0.8rem;
    opacity: 0.6;
  }
  .term-actions {
    display: flex;
    gap: 0.3rem;
  }
  .term-edit input[type='text'],
  .term-edit select {
    min-width: 0;
  }
  .term-edit input[type='text'] {
    flex: 1 1 auto;
  }
  .term-delete span {
    flex: 1 1 auto;
    font-size: 0.85rem;
  }
  .term-merge .merge-into {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .term-merge .hint {
    flex: 1 1 12rem;
  }
  .term-merge progress {
    flex: 1 1 8rem;
    min-width: 6rem;
  }
  .merge-note {
    color: #8a6d00;
  }
  .danger {
    color: #b00020;
    border-color: #b00020;
  }
  .error {
    color: #b00020;
    font-size: 0.85rem;
  }
  .hint {
    opacity: 0.7;
    font-size: 0.85rem;
  }
</style>
