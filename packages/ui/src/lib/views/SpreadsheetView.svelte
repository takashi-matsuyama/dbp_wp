<script lang="ts">
  import type { WpMedia, WpPost, WpPostType } from '@dbp-wp/core';
  import { deriveChildren, getRelation, renderChildData, renderRecordTemplate } from '@dbp-wp/core';
  import {
    bulkDeleteMeta,
    clearRelation,
    fetchPosts,
    listMedia,
    resolveMedia,
    savePosts,
    setRelation,
    uploadMedia,
    type PostUpdate,
  } from '../api';
  import { computeMenuOrders } from '../formula';

  let {
    posts,
    type,
    connectorAvailable,
    postTypes,
    onsaved,
  }: {
    posts: WpPost[];
    type: string;
    connectorAvailable: boolean;
    postTypes: WpPostType[];
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

  // --- Parent/child relations (connector required) ---
  // Relations write immediately (one request per Set/Clear), independent of the batch Save:
  // the relation keys ride the standard `meta` field, a different path from the meta columns.

  interface ParentOption {
    id: number;
    title: string;
  }

  let relationRow = $state<number | null>(null); // child post id whose parent editor is open
  let relParentType = $state('');
  let relParentId = $state<number | null>(null);
  // Candidate parents per post type, fetched lazily for the picker (cross-type allowed).
  let relCandidates = $state<Record<string, ParentOption[]>>({});
  let relLoadingType = $state<string | null>(null);
  let relBusy = $state(false);
  let relError = $state<string | null>(null);

  // Types a parent may belong to: the site's REST types, or the current type as a fallback
  // when the type list could not be loaded (so same-type parenting still works).
  const parentTypeOptions = $derived<WpPostType[]>(
    postTypes.length > 0 ? postTypes : [{ slug: type, restBase: type, name: type }],
  );

  async function ensureCandidates(parentType: string): Promise<void> {
    if (relCandidates[parentType] !== undefined || relLoadingType === parentType) {
      return; // already cached or in flight
    }
    relLoadingType = parentType;
    try {
      const res = await fetchPosts({ type: parentType });
      relCandidates = {
        ...relCandidates,
        [parentType]: res.posts.map((p) => ({ id: p.id, title: p.title })),
      };
    } catch (e) {
      relError = e instanceof Error ? e.message : String(e);
    } finally {
      relLoadingType = null;
    }
  }

  function openRelationEditor(post: WpPost): void {
    const current = getRelation(post);
    relationRow = post.id;
    relError = null;
    relParentType = current?.parentType ?? parentTypeOptions[0]?.restBase ?? type;
    relParentId = current?.parentId ?? null;
    void ensureCandidates(relParentType);
  }

  function closeRelationEditor(): void {
    relationRow = null;
    relError = null;
  }

  function changeRelParentType(next: string): void {
    relParentType = next;
    relParentId = null; // a parent from the previous type no longer applies
    void ensureCandidates(next);
  }

  // Candidate parents for the open editor, excluding the child itself (no self-parent).
  function candidatesFor(childId: number): ParentOption[] {
    return (relCandidates[relParentType] ?? []).filter((c) => c.id !== childId);
  }

  async function applySetRelation(childId: number): Promise<void> {
    if (relBusy || relParentId === null) {
      return;
    }
    relBusy = true;
    relError = null;
    try {
      await setRelation(childId, type, relParentId, relParentType);
      closeRelationEditor();
      await onsaved();
    } catch (e) {
      relError = e instanceof Error ? e.message : String(e);
    } finally {
      relBusy = false;
    }
  }

  async function applyClearRelation(childId: number): Promise<void> {
    if (relBusy) {
      return;
    }
    relBusy = true;
    relError = null;
    try {
      await clearRelation(childId, type);
      closeRelationEditor();
      await onsaved();
    } catch (e) {
      relError = e instanceof Error ? e.message : String(e);
    } finally {
      relBusy = false;
    }
  }

  // Show a parent as its title when resolvable: a same-type parent comes from the loaded
  // grid; a cross-type parent comes from the candidate cache (loaded by the effect below).
  // Falls back to "Type #id" while loading or if the parent is not among the fetched posts.
  function parentLabel(post: WpPost): string {
    const rel = getRelation(post);
    if (!rel) {
      return '';
    }
    const typeName = postTypes.find((pt) => pt.restBase === rel.parentType)?.name ?? rel.parentType;
    const title =
      rel.parentType === type
        ? posts.find((p) => p.id === rel.parentId)?.title
        : relCandidates[rel.parentType]?.find((c) => c.id === rel.parentId)?.title;
    return title ? `${typeName}: ${title}` : `${typeName} #${rel.parentId}`;
  }

  // Pre-load the posts of any cross-type parent present in the grid so parentLabel can show
  // their titles (each type fetched once into the candidate cache).
  $effect(() => {
    const parentTypes = new Set<string>();
    for (const post of posts) {
      const rel = getRelation(post);
      if (rel && rel.parentType !== type) {
        parentTypes.add(rel.parentType);
      }
    }
    for (const parentType of parentTypes) {
      void ensureCandidates(parentType);
    }
  });

  // --- Child data (template aggregation of a parent's children) ---
  // A single column-level template, rendered live against each parent's derived children
  // (deriveChildren + the Print template engine). Nothing is written to WordPress and no
  // value is cached, so it can never go stale — the legacy `_dbpcloudwp_child_value` sync
  // bug is avoided by design. The template is UI state (not persisted); persisting column
  // config belongs to a later data-stract slice.
  let childTemplate = $state('');

  // Validate the template once (parse errors are row-independent): rendering against an
  // empty record surfaces an unbalanced {{#each}} without needing a real parent.
  const childTemplateError = $derived.by<string | null>(() => {
    const tpl = childTemplate.trim();
    if (tpl === '') {
      return null;
    }
    try {
      renderRecordTemplate(tpl, {}, { escape: false });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });

  const showChildData = $derived(childTemplate.trim() !== '');

  // Rendered child-data text for one parent row. Returns '' while the template is invalid so
  // the grid keeps rendering (the error is shown once in the toolbar instead).
  function childData(post: WpPost): string {
    if (!showChildData || childTemplateError) {
      return '';
    }
    return renderChildData(childTemplate, post, posts);
  }

  // --- Featured image (core REST `featured_media`; no connector needed) ---
  // Assignment is a draft (the post id → new featured media id; 0 = remove) that rides the
  // existing batch Save, just like title/menu_order. Uploading an image is immediate (it
  // creates a media item), but assigning it to the post waits for Save.

  let featuredDrafts = $state<Record<number, number>>({});
  // Cache of media id → preview URL, filled lazily so the lean post listing stays embed-free.
  let mediaUrls = $state<Record<number, string>>({});
  // Non-reactive guard so each featured id is only resolved once (avoids an effect loop).
  const requestedMediaIds = new Set<number>();

  // The media id currently shown for a post: a draft wins (0 means "no image"), else the
  // post's saved featured_media.
  function effectiveFeatured(post: WpPost): number | undefined {
    const draft = featuredDrafts[post.id];
    if (draft !== undefined) {
      return draft === 0 ? undefined : draft;
    }
    return post.featuredMedia;
  }

  function isFeaturedChanged(post: WpPost): boolean {
    const draft = featuredDrafts[post.id];
    return draft !== undefined && draft !== (post.featuredMedia ?? 0);
  }

  function removeFeatured(post: WpPost): void {
    featuredDrafts[post.id] = 0;
  }

  async function resolveFeaturedUrls(ids: number[]): Promise<void> {
    try {
      const media = await resolveMedia(ids);
      const next = { ...mediaUrls };
      for (const m of media) {
        next[m.id] = m.thumbnailUrl || m.sourceUrl;
      }
      mediaUrls = next;
    } catch {
      // Thumbnails are best-effort. Unmark these ids so a later render (refresh/save) can
      // retry — a transient failure must not lock them out for the component's lifetime.
      for (const id of ids) {
        requestedMediaIds.delete(id);
      }
    }
  }

  // Resolve preview URLs for the featured images on the loaded posts (once per id).
  $effect(() => {
    const ids: number[] = [];
    for (const post of posts) {
      const id = post.featuredMedia;
      if (id !== undefined && !requestedMediaIds.has(id)) {
        requestedMediaIds.add(id);
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      void resolveFeaturedUrls(ids);
    }
  });

  // --- Media picker (modal) ---
  let pickerForPost = $state<number | null>(null);
  let mediaItems = $state<WpMedia[]>([]);
  let mediaPage = $state(1);
  let mediaTotalPages = $state(1);
  let mediaSearch = $state('');
  let mediaLoading = $state(false);
  let mediaError = $state<string | null>(null);
  let uploading = $state(false);

  async function loadMedia(): Promise<void> {
    mediaLoading = true;
    mediaError = null;
    try {
      const search = mediaSearch.trim();
      const res = await listMedia(search ? { page: mediaPage, search } : { page: mediaPage });
      mediaItems = res.items;
      mediaTotalPages = res.totalPages;
    } catch (e) {
      mediaError = e instanceof Error ? e.message : String(e);
    } finally {
      mediaLoading = false;
    }
  }

  function openPicker(post: WpPost): void {
    pickerForPost = post.id;
    mediaSearch = '';
    mediaPage = 1;
    mediaError = null;
    void loadMedia();
  }

  function closePicker(): void {
    pickerForPost = null;
  }

  function searchMedia(): void {
    mediaPage = 1;
    void loadMedia();
  }

  function gotoMediaPage(page: number): void {
    const next = Math.min(Math.max(1, page), mediaTotalPages);
    if (next !== mediaPage) {
      mediaPage = next;
      void loadMedia();
    }
  }

  // Assign a media item as a specific post's featured image (draft) and cache its preview.
  function assignFeatured(targetId: number, media: WpMedia): void {
    featuredDrafts[targetId] = media.id;
    mediaUrls = { ...mediaUrls, [media.id]: media.thumbnailUrl || media.sourceUrl };
    requestedMediaIds.add(media.id);
  }

  // Pick from the library: assign to the open row and close the picker.
  function selectMedia(media: WpMedia): void {
    if (pickerForPost !== null) {
      assignFeatured(pickerForPost, media);
    }
    closePicker();
  }

  async function handleUpload(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    // Capture the target row before awaiting: the user could reopen the picker on another
    // row mid-upload, and the new media must land on the row it was uploaded for.
    const targetId = pickerForPost;
    uploading = true;
    mediaError = null;
    try {
      const media = await uploadMedia(file);
      if (targetId !== null) {
        assignFeatured(targetId, media);
      }
      // Close only if the picker is still on the row we uploaded for.
      if (pickerForPost === targetId) {
        closePicker();
      }
    } catch (e) {
      mediaError = e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
      input.value = ''; // allow re-selecting the same file
    }
  }

  // --- Drag-and-drop reorder (→ menu_order) ---
  // `rowOrder` is the dragged display order (post ids); it is used only while it is a valid
  // permutation of the loaded posts, otherwise the grid falls back to the posts' own order
  // (so a refresh or type switch resets cleanly, no effect needed). On drop the order is
  // written into the menu_order drafts (1-based) and rides the existing batch Save.
  let rowOrder = $state<number[]>([]);
  let dragId = $state<number | null>(null);

  const postById = $derived(new Map(posts.map((p) => [p.id, p])));

  const displayOrder = $derived.by(() => {
    const ids = posts.map((p) => p.id);
    const valid = rowOrder.length === ids.length && ids.every((id) => rowOrder.includes(id));
    return valid ? rowOrder : ids;
  });

  function moveInOrder(fromId: number, toId: number): void {
    if (fromId === toId) {
      return;
    }
    const next = [...rowOrder];
    const from = next.indexOf(fromId);
    const to = next.indexOf(toId);
    if (from < 0 || to < 0) {
      return;
    }
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    rowOrder = next;
  }

  function startRowDrag(id: number): void {
    rowOrder = displayOrder.slice(); // snapshot the current order before dragging
    dragId = id;
  }

  function dragRowOver(event: DragEvent, targetId: number): void {
    if (dragId === null) {
      return;
    }
    event.preventDefault(); // allow drop + reorder live as the row is dragged over others
    moveInOrder(dragId, targetId);
  }

  // Write the final order into the menu_order drafts (1-based). Rows whose position changed
  // become "changed" and ride the existing Save; rows already at their number stay untouched.
  function endRowDrag(): void {
    if (dragId === null) {
      return;
    }
    const next = { ...drafts };
    displayOrder.forEach((id, index) => {
      const post = postById.get(id);
      if (!post) {
        return;
      }
      next[id] = {
        ...(next[id] ?? { title: post.title, menuOrder: post.menuOrder }),
        menuOrder: index + 1,
      };
    });
    drafts = next;
    dragId = null;
  }

  function isChanged(post: WpPost): boolean {
    const draft = drafts[post.id];
    const fieldChanged =
      draft !== undefined && (draft.title !== post.title || draft.menuOrder !== post.menuOrder);
    return (
      fieldChanged ||
      isFeaturedChanged(post) ||
      metaColumns.some((key) => isMetaChanged(post, key))
    );
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
      const featured = featuredDrafts[post.id];
      if (featured !== undefined && featured !== (post.featuredMedia ?? 0)) {
        // The draft is the new featured_media id (0 removes it).
        update.featuredMedia = featured;
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
      const results = await savePosts(buildUpdates(), type);
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
        const remainingFeatured = { ...featuredDrafts };
        for (const id of succeeded) {
          delete remaining[id];
          delete remainingMeta[id];
          delete remainingFeatured[id];
        }
        drafts = remaining;
        metaDrafts = remainingMeta;
        featuredDrafts = remainingFeatured;
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
    <button onclick={save} disabled={saving || deleteBusy || relBusy || changed.length === 0}>
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
    <div class="child-bar">
      <label class="child-template-label">
        Child data template
        <textarea
          class="child-template"
          bind:value={childTemplate}
          rows="2"
          placeholder={'{{#each children}}{{ this.title }}, {{/each}}'}
          disabled={saving}
        ></textarea>
      </label>
      <span class="hint">per parent row: childCount, children[].title / .status / .meta.&lt;key&gt;</span>
      {#if childTemplateError}<span class="error">{childTemplateError}</span>{/if}
    </div>
  {:else}
    <p class="restricted-note">
      Custom field editing and parent/child relations need the DBP WP Connector plugin.
      Standard fields are editable.
    </p>
  {/if}

  <table class="sheet">
    <thead>
      <tr>
        <th class="drag-col" aria-hidden="true"></th>
        <th>ID</th>
        <th>Title</th>
        <th>Menu order</th>
        <th>Featured</th>
        {#if connectorAvailable}
          <th>Parent</th>
          <th>Children</th>
          {#if showChildData}
            <th>Child data</th>
          {/if}
        {/if}
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
      {#each displayOrder as id (id)}
        {@const post = postById.get(id)}
        {#if post}
          {@const fid = effectiveFeatured(post)}
          <tr
            class:changed={isChanged(post)}
            class:dragging={dragId === post.id}
            ondragover={(e) => dragRowOver(e, post.id)}
            ondrop={(e) => e.preventDefault()}
          >
            <td
              class="drag-handle"
              draggable={!saving && !deleteBusy && !relBusy}
              ondragstart={() => startRowDrag(post.id)}
              ondragend={endRowDrag}
              title="Drag to reorder (sets menu order)">⠿</td>
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
          <td class="featured-cell" class:changed-cell={isFeaturedChanged(post)}>
            {#if fid !== undefined}
              {#if mediaUrls[fid]}
                <img class="featured-thumb" src={mediaUrls[fid]} alt="" />
              {/if}
              <span class="featured-id">#{fid}</span>
              <button
                class="rel-edit"
                onclick={() => openPicker(post)}
                disabled={saving || deleteBusy || relBusy}>Change</button
              >
              <button
                class="rel-edit"
                onclick={() => removeFeatured(post)}
                disabled={saving || deleteBusy || relBusy}>Remove</button
              >
            {:else}
              <span class="parent-none">—</span>
              <button
                class="rel-edit"
                onclick={() => openPicker(post)}
                disabled={saving || deleteBusy || relBusy}>Set image</button
              >
            {/if}
          </td>
          {#if connectorAvailable}
            <td class="relation-cell">
              {#if relationRow === post.id}
                <div class="relation-editor">
                  <select
                    value={relParentType}
                    disabled={relBusy}
                    onchange={(e) => changeRelParentType((e.currentTarget as HTMLSelectElement).value)}
                  >
                    {#each parentTypeOptions as pt (pt.restBase)}
                      <option value={pt.restBase}>{pt.name}</option>
                    {/each}
                  </select>
                  {#if relLoadingType === relParentType}
                    <span class="hint">Loading…</span>
                  {:else}
                    <select
                      value={relParentId === null ? '' : String(relParentId)}
                      disabled={relBusy}
                      onchange={(e) => {
                        const v = (e.currentTarget as HTMLSelectElement).value;
                        relParentId = v === '' ? null : Number(v);
                      }}
                    >
                      <option value="">Select parent…</option>
                      {#each candidatesFor(post.id) as c (c.id)}
                        <option value={String(c.id)}>{c.title} (#{c.id})</option>
                      {/each}
                    </select>
                  {/if}
                  <button onclick={() => applySetRelation(post.id)} disabled={relBusy || relParentId === null}>
                    {relBusy ? 'Saving…' : 'Set'}
                  </button>
                  {#if getRelation(post)}
                    <button onclick={() => applyClearRelation(post.id)} disabled={relBusy}>Clear</button>
                  {/if}
                  <button onclick={closeRelationEditor} disabled={relBusy}>Cancel</button>
                  {#if relError}<span class="error">{relError}</span>{/if}
                </div>
              {:else if getRelation(post)}
                <span class="parent-ref">{parentLabel(post)}</span>
                <button
                  class="rel-edit"
                  onclick={() => openRelationEditor(post)}
                  disabled={saving || deleteBusy || relBusy}>Edit</button
                >
              {:else}
                <span class="parent-none">—</span>
                <button
                  class="rel-edit"
                  onclick={() => openRelationEditor(post)}
                  disabled={saving || deleteBusy || relBusy}>Set parent</button
                >
              {/if}
            </td>
            <td class="children-cell">
              {#if deriveChildren(posts, post.id).length > 0}
                <span
                  class="child-count"
                  title={deriveChildren(posts, post.id)
                    .map((c) => `#${c.id} ${c.title}`)
                    .join('\n')}>{deriveChildren(posts, post.id).length}</span
                >
              {:else}
                <span class="parent-none">—</span>
              {/if}
            </td>
            {#if showChildData}
              <td class="child-data-cell">{childData(post)}</td>
            {/if}
          {/if}
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
        {/if}
      {/each}
    </tbody>
  </table>
{/if}

{#if pickerForPost !== null}
  <div
    class="picker-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closePicker();
    }}
  >
    <div class="picker" role="dialog" aria-modal="true" aria-label="Media library">
      <div class="picker-head">
        <strong>Media library</strong>
        <input
          class="picker-search"
          bind:value={mediaSearch}
          placeholder="Search media…"
          onkeydown={(e) => e.key === 'Enter' && searchMedia()}
        />
        <button onclick={searchMedia} disabled={mediaLoading}>Search</button>
        <label class="picker-upload">
          {uploading ? 'Uploading…' : 'Upload'}
          <input type="file" accept="image/*" onchange={handleUpload} disabled={uploading} />
        </label>
        <button class="picker-close" onclick={closePicker} aria-label="Close">×</button>
      </div>
      {#if mediaError}<p class="error">{mediaError}</p>{/if}
      {#if mediaLoading}
        <p class="picker-status">Loading…</p>
      {:else if mediaItems.length === 0}
        <p class="picker-status">No media found.</p>
      {:else}
        <div class="picker-grid">
          {#each mediaItems as media (media.id)}
            <button class="picker-item" onclick={() => selectMedia(media)} title={media.title}>
              <img src={media.thumbnailUrl || media.sourceUrl} alt={media.title} />
              <span class="picker-item-label">#{media.id} {media.title}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="picker-pager">
        <button onclick={() => gotoMediaPage(mediaPage - 1)} disabled={mediaLoading || mediaPage <= 1}
          >‹ Prev</button
        >
        <span>Page {mediaPage} / {mediaTotalPages}</span>
        <button
          onclick={() => gotoMediaPage(mediaPage + 1)}
          disabled={mediaLoading || mediaPage >= mediaTotalPages}>Next ›</button
        >
      </div>
    </div>
  </div>
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
  .relation-cell {
    white-space: nowrap;
  }
  .relation-editor {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .relation-editor .error {
    flex-basis: 100%;
  }
  .rel-edit {
    margin-left: 0.35rem;
    padding: 0 0.4rem;
    line-height: 1.4;
    cursor: pointer;
  }
  .parent-none {
    opacity: 0.5;
  }
  .children-cell {
    text-align: center;
  }
  .child-count {
    cursor: help;
  }
  .child-bar {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0.5rem 0;
    flex-wrap: wrap;
  }
  .child-template-label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.85rem;
  }
  .child-template {
    width: min(28rem, 100%);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
  }
  .child-data-cell {
    white-space: pre-wrap;
    max-width: 22rem;
    font-size: 0.85rem;
    vertical-align: top;
  }
  .drag-col {
    width: 1.6rem;
  }
  .drag-handle {
    cursor: grab;
    text-align: center;
    color: #999;
    user-select: none;
  }
  .drag-handle:active {
    cursor: grabbing;
  }
  tr.dragging {
    opacity: 0.4;
  }
  .featured-cell {
    white-space: nowrap;
  }
  .featured-cell.changed-cell {
    background: rgba(255, 215, 0, 0.18);
  }
  .featured-thumb {
    width: 2rem;
    height: 2rem;
    object-fit: cover;
    vertical-align: middle;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 3px;
  }
  .featured-id {
    margin: 0 0.25rem;
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }
  .picker {
    background: Canvas;
    color: CanvasText;
    border-radius: 6px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
    width: min(720px, 100%);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    padding: 1rem;
  }
  .picker-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .picker-search {
    flex: 1 1 12rem;
  }
  .picker-upload {
    cursor: pointer;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.85rem;
  }
  /* Visually hidden but still keyboard-focusable (display:none would drop it from the tab
     order, so keyboard users could not trigger upload). :focus-within shows the focus ring. */
  .picker-upload input[type='file'] {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .picker-upload:focus-within {
    outline: 2px solid #2563eb;
    outline-offset: 1px;
  }
  .picker-close {
    margin-left: auto;
    line-height: 1;
    padding: 0 0.4rem;
    cursor: pointer;
  }
  .picker-status {
    padding: 1rem;
    opacity: 0.7;
  }
  .picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.5rem;
    overflow-y: auto;
    margin: 0.5rem 0;
    padding: 0.25rem;
  }
  .picker-item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 4px;
    padding: 0.25rem;
    cursor: pointer;
    background: none;
    color: inherit;
  }
  .picker-item:hover {
    border-color: #2563eb;
  }
  .picker-item img {
    width: 100%;
    height: 80px;
    object-fit: cover;
    border-radius: 3px;
  }
  .picker-item-label {
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    font-size: 0.85rem;
  }
</style>
