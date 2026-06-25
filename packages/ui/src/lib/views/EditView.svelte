<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { renderMarkdown, type WpMedia } from '@dbp-wp/core';
  import { fetchPost, savePostBody, listMedia, uploadMedia } from '../api';
  import {
    applyInline,
    applyBlock,
    continueBlock,
    insertImage,
    textStats,
    type InlineKind,
    type BlockKind,
  } from '../editorOps';
  import { extractHeadings, proportionalScrollTop, type Heading } from '../editorNav';

  let {
    id,
    type,
    connectorAvailable,
    onclose,
  }: {
    id: number;
    type: string;
    /** Whether the companion plugin is active; Markdown mode requires it (else HTML only). */
    connectorAvailable: boolean;
    /** Return to the list. The caller refreshes, so any saved changes show there. */
    onclose: () => void;
  } = $props();

  type Mode = 'markdown' | 'html';

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let hasSavedOnce = $state(false);

  let title = $state('');
  // Two independent buffers; the active `mode` decides what is previewed and saved. Switching
  // never discards either, so a user can flip between representations before committing.
  let markdownText = $state('');
  let htmlText = $state('');
  let mode = $state<Mode>('html');
  // Whether the loaded post carried a Markdown source, so an HTML-mode save knows to clear it
  // (keeping the auto-detected mode consistent on reopen). Updated from each save's result.
  let hadMarkdown = $state(false);

  // Snapshot of the last-saved/loaded buffers, to detect unsaved edits before leaving.
  let savedMarkdown = $state('');
  let savedHtml = $state('');
  let savedMode = $state<Mode>('html');
  let confirmingDiscard = $state(false);

  // Toolbar/shortcut plumbing: refs to the two textareas so formatting ops can read the live
  // selection and restore it after rewriting the buffer. Only the active mode's textarea mounts.
  let markdownEl = $state<HTMLTextAreaElement | null>(null);
  let htmlEl = $state<HTMLTextAreaElement | null>(null);
  let previewEl = $state<HTMLIFrameElement | null>(null);
  let fullscreen = $state(false);
  let outlineOpen = $state(false);

  // --- Image insertion (reuses the core media API — no new dependency) ---
  let pickerOpen = $state(false);
  let mediaItems = $state<WpMedia[]>([]);
  let mediaLoading = $state(false);
  let mediaError = $state<string | null>(null);
  let mediaSearch = $state('');
  let mediaPage = $state(1);
  let mediaTotalPages = $state(1);
  let uploading = $state(false);
  let selectedMedia = $state<WpMedia | null>(null);
  let imgAlt = $state('');
  let imgSizeName = $state('');
  let dragOver = $state(false);

  function snapshot(): void {
    savedMarkdown = markdownText;
    savedHtml = htmlText;
    savedMode = mode;
  }

  const dirty = $derived(
    mode !== savedMode || markdownText !== savedMarkdown || htmlText !== savedHtml,
  );

  const stats = $derived(textStats(mode === 'markdown' ? markdownText : htmlText));

  // Heading outline of the active buffer (recomputed as the text changes). Cheap regex scan; only
  // read when the outline panel is open, so a closed panel costs nothing.
  const headings = $derived(extractHeadings(mode === 'markdown' ? markdownText : htmlText, mode));

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const post = await fetchPost(id, type);
      title = post.title;
      htmlText = post.content;
      // A returned Markdown source means Markdown mode. Its mere presence proves the connector
      // is active (only the registered key surfaces it), so it — not a possibly-stale
      // `connectorAvailable` probe — is the source of truth. Keeping `hadMarkdown` aligned with
      // the live fetch ensures a later HTML save reliably clears the meta.
      if (post.markdown !== undefined) {
        markdownText = post.markdown;
        mode = 'markdown';
        hadMarkdown = true;
      } else {
        markdownText = '';
        mode = 'html';
        hadMarkdown = false;
      }
      snapshot();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Switch editing mode without losing data. Markdown→HTML bakes the current Markdown into the
  // HTML buffer (one-way, via the same renderer used for preview/save) so the HTML tab reflects
  // what was just written. HTML→Markdown cannot be auto-converted, so it keeps the Markdown
  // buffer as-is; the HTML buffer is preserved in case the user switches back. The active mode
  // at save time wins.
  function switchMode(next: Mode): void {
    if (next === mode) {
      return;
    }
    if (next === 'html') {
      htmlText = renderMarkdown(markdownText);
    }
    mode = next;
  }

  // Live preview body: render the active buffer. Markdown goes through the shared core renderer;
  // HTML is shown as-is. Not sanitized here — WordPress kses sanitizes on save, and the preview
  // is a sandboxed iframe with no script execution (XSS isolation), per the body-editing design.
  const previewBody = $derived(mode === 'markdown' ? renderMarkdown(markdownText) : htmlText);

  const previewDoc = $derived(buildPreviewDoc(previewBody));

  function buildPreviewDoc(body: string): string {
    const base = `
    html, body { margin: 0; padding: 1rem; font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; }
    img { max-width: 100%; height: auto; }
    pre { background: #f4f4f4; padding: 0.75rem; overflow-x: auto; }
    code { font-family: ui-monospace, monospace; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #ccc; padding: 0.3rem 0.6rem; }
    blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 1rem; color: #555; }`;
    // Defense-in-depth on top of the script-free sandbox: a CSP that blocks everything except
    // inline styles and https/data images. Stops post HTML from issuing passive requests (e.g.
    // an <img> pointed at the loopback CLI origin) while keeping image preview working.
    const csp =
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'";
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style></head><body>${body}</body></html>`;
  }

  async function save(): Promise<void> {
    saving = true;
    saveError = null;
    try {
      // Markdown mode: write the rendered HTML to `content` and store the source. HTML mode:
      // write the HTML; clear a previously-stored source (only needed/possible in full mode) so
      // the post reopens as HTML. Both ride one request.
      const post = await savePostBody(
        id,
        type,
        mode === 'markdown'
          ? { content: renderMarkdown(markdownText), markdown: markdownText }
          : hadMarkdown
            ? { content: htmlText, markdown: null }
            : { content: htmlText },
      );
      // Resync from the persisted state so subsequent saves and the dirty check stay correct,
      // and so the shown mode matches how the post will reopen — e.g. saving an empty Markdown
      // source persists as HTML mode (the normalizer treats only a non-empty source as Markdown).
      htmlText = post.content;
      if (post.markdown !== undefined) {
        markdownText = post.markdown;
        mode = 'markdown';
        hadMarkdown = true;
      } else {
        mode = 'html';
        hadMarkdown = false;
      }
      snapshot();
      hasSavedOnce = true;
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function activeEl(): HTMLTextAreaElement | null {
    return mode === 'markdown' ? markdownEl : htmlEl;
  }

  // Apply a toolbar transform to the active buffer using the live textarea selection, then restore
  // focus and the returned selection so the user can keep typing. await tick() lets Svelte flush
  // the new value to the DOM before we set the selection range.
  async function runInline(kind: InlineKind): Promise<void> {
    const el = activeEl();
    if (!el) return;
    const r = applyInline({ value: el.value, start: el.selectionStart, end: el.selectionEnd }, kind, mode);
    if (mode === 'markdown') markdownText = r.value;
    else htmlText = r.value;
    await tick();
    el.focus();
    el.setSelectionRange(r.start, r.end);
  }

  async function runBlock(kind: BlockKind, level = 2): Promise<void> {
    const el = activeEl();
    if (!el) return;
    const r = applyBlock(
      { value: el.value, start: el.selectionStart, end: el.selectionEnd },
      kind,
      mode,
      level,
    );
    if (mode === 'markdown') markdownText = r.value;
    else htmlText = r.value;
    await tick();
    el.focus();
    el.setSelectionRange(r.start, r.end);
  }

  // One-way editor→preview sync scroll: map the active textarea's scroll fraction onto the preview.
  // The preview is a `sandbox="allow-same-origin"` srcdoc iframe (no `allow-scripts`), so its scripts
  // never run, but the parent — same-origin — may drive its scroll position. Guarded so a transiently
  // cross-origin or not-yet-loaded frame is a no-op rather than a throw.
  function syncPreviewScroll(): void {
    const el = activeEl();
    const frame = previewEl;
    if (!el || !frame) return;
    try {
      const win = frame.contentWindow;
      const root = frame.contentDocument?.documentElement;
      if (!win || !root) return;
      const top = proportionalScrollTop(
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight },
      );
      win.scrollTo(0, top);
    } catch {
      // Same-origin access denied (shouldn't happen with allow-same-origin) — skip silently.
    }
  }

  // Scroll the textarea so the line at `offset` sits near the top. Line-height comes from computed
  // style (the textarea sets an explicit one, so it parses); this is a deliberate estimate — wrapped
  // lines above the target make it under-scroll slightly, which is fine for a jump-to-heading.
  function scrollOffsetIntoView(el: HTMLTextAreaElement, offset: number): void {
    const line = el.value.slice(0, offset).split('\n').length - 1;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 18;
    const padTop = parseFloat(cs.paddingTop) || 0;
    el.scrollTop = Math.max(0, line * lineHeight + padTop - lineHeight);
  }

  // Jump from an outline entry to its heading: place the caret at the source offset, scroll the
  // textarea there, and let the preview follow via the one-way sync. Single mechanism, so editor and
  // preview stay consistent.
  async function jumpToHeading(h: Heading): Promise<void> {
    const el = activeEl();
    if (!el) return;
    el.focus();
    el.setSelectionRange(h.offset, h.offset);
    await tick();
    scrollOffsetIntoView(el, h.offset);
    syncPreviewScroll();
  }

  // Editor shortcuts: Enter continues a Markdown list/quote; Cmd/Ctrl+S saves, Cmd/Ctrl+B/I apply
  // bold/italic. Other keys fall through to the textarea's default handling.
  function onEditorKeydown(e: KeyboardEvent): void {
    // Never act on a keystroke that is finishing IME composition (e.g. confirming a Japanese
    // conversion with Enter) — it must reach the textarea as a commit, not trigger a shortcut.
    if (e.isComposing) return;
    // Smart list/quote continuation on plain Enter (Markdown line markers; collapsed caret only).
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && mode === 'markdown') {
      const el = activeEl();
      if (el && el.selectionStart === el.selectionEnd) {
        const r = continueBlock(el.value, el.selectionStart);
        if (r) {
          e.preventDefault();
          markdownText = r.value;
          void tick().then(() => {
            el.focus();
            el.setSelectionRange(r.start, r.end);
          });
        }
      }
      return; // plain Enter (no list context) keeps its default behavior
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      if (!saving && dirty) void save();
    } else if (key === 'b') {
      e.preventDefault();
      void runInline('bold');
    } else if (key === 'i') {
      e.preventDefault();
      void runInline('italic');
    }
  }

  async function loadMedia(page = 1): Promise<void> {
    mediaLoading = true;
    mediaError = null;
    try {
      const query: { page: number; search?: string } = { page };
      const search = mediaSearch.trim();
      if (search !== '') query.search = search;
      const res = await listMedia(query);
      mediaItems = res.items;
      mediaTotalPages = res.totalPages;
      mediaPage = page;
    } catch (e) {
      mediaError = e instanceof Error ? e.message : String(e);
    } finally {
      mediaLoading = false;
    }
  }

  function openPicker(): void {
    pickerOpen = true;
    selectedMedia = null;
    imgAlt = '';
    if (mediaItems.length === 0) void loadMedia(1);
  }

  function closePicker(): void {
    pickerOpen = false;
    selectedMedia = null;
    imgAlt = '';
  }

  // Pick a media item: default to a mid/large size and seed alt from the title (still editable and
  // still required — the Insert button stays disabled until alt is non-empty).
  function chooseMedia(m: WpMedia): void {
    selectedMedia = m;
    const names = m.sizes.map((s) => s.name);
    imgSizeName = names.includes('large')
      ? 'large'
      : names.includes('full')
        ? 'full'
        : (names.at(-1) ?? '');
    imgAlt = m.title;
  }

  // Upload an image file (from the file input, a drop, or a paste) and select it for insertion.
  async function handleFiles(files: FileList | File[] | null): Promise<void> {
    if (saving) return;
    const file = files && files[0];
    if (!file || !file.type.startsWith('image/')) return;
    uploading = true;
    mediaError = null;
    pickerOpen = true;
    try {
      const m = await uploadMedia(file);
      mediaItems = [m, ...mediaItems];
      chooseMedia(m);
    } catch (e) {
      mediaError = e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
    }
  }

  function onEditorDrop(e: DragEvent): void {
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0 || !files[0]?.type.startsWith('image/')) return;
    e.preventDefault();
    void handleFiles(files);
  }

  function onEditorDragOver(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) return;
    e.preventDefault();
    dragOver = true;
  }

  function onEditorPaste(e: ClipboardEvent): void {
    for (const it of e.clipboardData?.items ?? []) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          void handleFiles([file]);
        }
        return;
      }
    }
  }

  function selectedSizeUrl(): string {
    const m = selectedMedia;
    if (!m) return '';
    return m.sizes.find((s) => s.name === imgSizeName)?.url ?? m.sourceUrl;
  }

  // Insert the chosen image at the cursor in the active buffer, then close the picker and restore
  // focus. Alt is required (guarded here and via the disabled Insert button).
  async function confirmInsertImage(): Promise<void> {
    if (saving) return;
    const url = selectedSizeUrl();
    const alt = imgAlt.trim();
    if (url === '' || alt === '') return;
    const el = activeEl();
    if (!el) return;
    const r = insertImage(
      { value: el.value, start: el.selectionStart, end: el.selectionEnd },
      { url, alt },
      mode,
    );
    if (mode === 'markdown') markdownText = r.value;
    else htmlText = r.value;
    closePicker();
    await tick();
    el.focus();
    el.setSelectionRange(r.start, r.end);
  }

  function requestClose(): void {
    if (dirty) {
      confirmingDiscard = true;
      return;
    }
    onclose();
  }

  onMount(() => {
    void load();
  });
</script>

<div class="edit-view" class:fullscreen>
  <section class="panel">
    <div class="edit-head">
      <button class="back" onclick={requestClose}>← Back to list</button>
      <h2 class="post-title" title={title}>{title || '(untitled)'}</h2>
    </div>

    {#if confirmingDiscard}
      <p class="confirm">
        Discard unsaved changes?
        <button onclick={onclose}>Discard</button>
        <button onclick={() => (confirmingDiscard = false)}>Keep editing</button>
      </p>
    {/if}

    {#if loading}
      <p>Loading…</p>
    {:else if loadError}
      <p class="error">{loadError} <button class="link" onclick={load}>Retry</button></p>
    {:else}
      <div class="mode-tabs" role="tablist" aria-label="Editing mode">
        {#if connectorAvailable}
          <button
            role="tab"
            aria-selected={mode === 'markdown'}
            class:active={mode === 'markdown'}
            disabled={saving}
            onclick={() => switchMode('markdown')}>Markdown</button
          >
        {/if}
        <button
          role="tab"
          aria-selected={mode === 'html'}
          class:active={mode === 'html'}
          disabled={saving}
          onclick={() => switchMode('html')}>HTML</button
        >
      </div>

      {#if !connectorAvailable}
        <p class="restricted-note">
          Markdown mode needs the DBP WP Connector plugin; editing the body as HTML.
        </p>
      {/if}

      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" title="Bold (Cmd/Ctrl+B)" disabled={saving} onclick={() => runInline('bold')}><b>B</b></button>
        <button type="button" title="Italic (Cmd/Ctrl+I)" disabled={saving} onclick={() => runInline('italic')}><i>I</i></button>
        <button type="button" class="mono" title="Inline code" aria-label="Inline code" disabled={saving} onclick={() => runInline('code')}>&lt;/&gt;</button>
        <button type="button" title="Link" aria-label="Link" disabled={saving} onclick={() => runInline('link')}>🔗</button>
        <span class="tb-sep" aria-hidden="true"></span>
        <button type="button" title="Heading 2" disabled={saving} onclick={() => runBlock('heading', 2)}>H2</button>
        <button type="button" title="Heading 3" disabled={saving} onclick={() => runBlock('heading', 3)}>H3</button>
        <button type="button" title="Bulleted list" aria-label="Bulleted list" disabled={saving} onclick={() => runBlock('list')}>☰</button>
        <button type="button" class="mono" title="Numbered list" aria-label="Numbered list" disabled={saving} onclick={() => runBlock('orderedList')}>1.</button>
        <button type="button" title="Quote" aria-label="Quote" disabled={saving} onclick={() => runBlock('quote')}>❝</button>
        <span class="tb-sep" aria-hidden="true"></span>
        <button type="button" title="Insert image" aria-label="Insert image" aria-pressed={pickerOpen} disabled={saving} onclick={openPicker}>🖼</button>
        <span class="tb-spacer"></span>
        <button
          type="button"
          class="tb-toggle"
          title="Toggle heading outline"
          aria-expanded={outlineOpen}
          aria-controls="editor-outline"
          onclick={() => (outlineOpen = !outlineOpen)}>{outlineOpen ? '▾ Outline' : '▸ Outline'}</button
        >
        <button
          type="button"
          class="tb-toggle"
          title="Toggle full screen"
          aria-pressed={fullscreen}
          onclick={() => (fullscreen = !fullscreen)}>{fullscreen ? '⤡ Exit' : '⤢ Full'}</button
        >
      </div>

      {#if outlineOpen}
        <nav id="editor-outline" class="outline" aria-label="Heading outline">
          {#if headings.length === 0}
            <p class="hint">No headings yet.</p>
          {:else}
            <ul class="outline-list">
              {#each headings as h, i (i)}
                <li>
                  <button
                    type="button"
                    class="outline-item"
                    style="padding-left: {(h.level - 1) * 0.85 + 0.2}rem"
                    onclick={() => jumpToHeading(h)}
                  >
                    <span class="outline-lv">H{h.level}</span>
                    <span class="outline-tx">{h.text || '(untitled)'}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </nav>
      {/if}

      {#if pickerOpen}
        <div class="img-picker">
          <div class="img-picker-head">
            <strong>Insert image</strong>
            <button class="link" type="button" onclick={closePicker}>Close</button>
          </div>
          <div class="img-tools">
            <input
              type="search"
              placeholder="Search media…"
              bind:value={mediaSearch}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void loadMedia(1);
                }
              }}
            />
            <label class="upload-btn">
              {uploading ? 'Uploading…' : 'Upload'}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={uploading || saving}
                onchange={(e) => {
                  const input = e.currentTarget as HTMLInputElement;
                  void handleFiles(input.files);
                  input.value = '';
                }}
              />
            </label>
          </div>
          {#if mediaError}<p class="error">{mediaError}</p>{/if}
          {#if mediaLoading}
            <p class="hint">Loading…</p>
          {:else if mediaItems.length === 0}
            <p class="hint">No images yet. Upload one above.</p>
          {:else}
            <div class="media-grid">
              {#each mediaItems as m (m.id)}
                <button
                  type="button"
                  class="media-item"
                  class:sel={selectedMedia?.id === m.id}
                  title={m.title}
                  onclick={() => chooseMedia(m)}
                >
                  <img src={m.thumbnailUrl || m.sourceUrl} alt="" />
                </button>
              {/each}
            </div>
            {#if mediaTotalPages > 1}
              <div class="pager">
                <button type="button" disabled={mediaPage <= 1} onclick={() => void loadMedia(mediaPage - 1)}
                  >Prev</button
                >
                <span>{mediaPage} / {mediaTotalPages}</span>
                <button
                  type="button"
                  disabled={mediaPage >= mediaTotalPages}
                  onclick={() => void loadMedia(mediaPage + 1)}>Next</button
                >
              </div>
            {/if}
          {/if}
          {#if selectedMedia}
            <div class="img-form">
              {#if selectedMedia.sizes.length > 1}
                <label>
                  Size
                  <select bind:value={imgSizeName}>
                    {#each selectedMedia.sizes as s (s.name)}
                      <option value={s.name}
                        >{s.name}{s.width ? ` (${s.width}×${s.height})` : ''}</option
                      >
                    {/each}
                  </select>
                </label>
              {/if}
              <label class="alt-field">
                Alt text (required)
                <input type="text" bind:value={imgAlt} placeholder="Describe the image" />
              </label>
              <button
                class="primary"
                type="button"
                disabled={imgAlt.trim() === '' || saving}
                onclick={confirmInsertImage}>Insert</button
              >
            </div>
          {/if}
        </div>
      {/if}

      {#if mode === 'markdown'}
        <label class="field">
          <span>Markdown source</span>
          <textarea
            bind:this={markdownEl}
            bind:value={markdownText}
            onkeydown={onEditorKeydown}
            onpaste={onEditorPaste}
            ondrop={onEditorDrop}
            ondragover={onEditorDragOver}
            ondragleave={() => (dragOver = false)}
            onscroll={syncPreviewScroll}
            class:dragover={dragOver}
            spellcheck="false"
            rows="18"
            disabled={saving}
          ></textarea>
        </label>
      {:else}
        <label class="field">
          <span>Body (HTML)</span>
          <textarea
            bind:this={htmlEl}
            bind:value={htmlText}
            onkeydown={onEditorKeydown}
            onpaste={onEditorPaste}
            ondrop={onEditorDrop}
            ondragover={onEditorDragOver}
            ondragleave={() => (dragOver = false)}
            onscroll={syncPreviewScroll}
            class:dragover={dragOver}
            spellcheck="false"
            rows="18"
            disabled={saving}
          ></textarea>
        </label>
      {/if}

      <div class="actions">
        <button class="primary" onclick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {#if saveError}
          <span class="error">{saveError}</span>
        {:else if hasSavedOnce && !dirty}
          <span class="saved">Saved ✓</span>
        {:else if dirty}
          <span class="hint">Unsaved changes</span>
        {/if}
        <span class="stats">{stats.words} words · {stats.chars} chars</span>
      </div>
    {/if}
  </section>

  <section class="preview">
    {#if loading}
      <p>Loading…</p>
    {:else}
      <iframe
        bind:this={previewEl}
        title="Body preview"
        srcdoc={previewDoc}
        sandbox="allow-same-origin"
        class="preview-frame"
        onload={syncPreviewScroll}
      ></iframe>
    {/if}
  </section>
</div>

<style>
  .edit-view {
    display: flex;
    gap: 1rem;
    align-items: stretch;
  }
  .edit-view.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 50;
    /* System color so the full-screen backdrop follows the light/dark scheme (not always white). */
    background: Canvas;
    padding: 1rem;
    margin: 0;
    overflow: auto;
  }
  .panel {
    flex: 0 0 26rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .edit-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .post-title {
    margin: 0;
    font-size: 1.1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .back {
    flex: 0 0 auto;
  }
  .mode-tabs {
    display: flex;
    gap: 0.25rem;
  }
  .mode-tabs button {
    /* currentColor-based tints so text stays readable in both light and dark schemes. */
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent);
    padding: 0.3rem 0.8rem;
    cursor: pointer;
  }
  .mode-tabs button.active {
    background: color-mix(in srgb, currentColor 16%, transparent);
    font-weight: bold;
  }
  .toolbar {
    display: flex;
    align-items: stretch;
    gap: 0.2rem;
    flex-wrap: wrap;
  }
  .toolbar button {
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    min-width: 2rem;
    padding: 0.25rem 0.45rem;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1.2;
  }
  .toolbar button:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
  .toolbar button.mono {
    font-family: ui-monospace, monospace;
  }
  .tb-sep {
    width: 1px;
    background: color-mix(in srgb, currentColor 20%, transparent);
    margin: 0 0.25rem;
  }
  .tb-spacer {
    flex: 1 1 auto;
  }
  .tb-toggle {
    white-space: nowrap;
  }
  .stats {
    margin-left: auto;
    opacity: 0.6;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .img-picker {
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent);
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .img-picker-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .img-tools {
    display: flex;
    gap: 0.5rem;
  }
  .img-tools input[type='search'] {
    flex: 1 1 auto;
    min-width: 0;
  }
  .upload-btn {
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
    gap: 0.35rem;
    max-height: 12rem;
    overflow-y: auto;
  }
  .media-item {
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    background: color-mix(in srgb, currentColor 6%, transparent);
    aspect-ratio: 1;
    overflow: hidden;
  }
  .media-item.sel {
    border-color: #2a7a2a;
  }
  .media-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .pager {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .img-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    padding-top: 0.5rem;
  }
  .img-form label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .img-form input[type='text'] {
    width: 100%;
    box-sizing: border-box;
  }
  textarea.dragover {
    outline: 2px dashed #2a7a2a;
    outline-offset: -2px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
  }
  .field textarea {
    font-family: monospace;
    font-size: 0.85rem;
    /* Explicit line-height so scrollOffsetIntoView can read a parseable px value (else "normal"). */
    line-height: 1.5;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }
  .outline {
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent);
    max-height: 12rem;
    overflow-y: auto;
    font-size: 0.85rem;
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
  }
  .outline-item {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    font-size: 0.85rem;
  }
  .outline-item:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .outline-lv {
    flex: 0 0 auto;
    opacity: 0.5;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
  }
  .outline-tx {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .outline .hint {
    margin: 0;
    padding: 0.5rem;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .actions .primary {
    padding: 0.4rem 1.2rem;
  }
  .saved {
    color: #2a7a2a;
    font-size: 0.85rem;
  }
  .hint {
    opacity: 0.7;
    font-size: 0.85rem;
  }
  .restricted-note {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .confirm {
    margin: 0;
    font-size: 0.85rem;
    /* Translucent amber so the warning reads on both light and dark backgrounds. */
    background: color-mix(in srgb, #f0c36d 18%, transparent);
    border: 1px solid color-mix(in srgb, #f0c36d 55%, transparent);
    padding: 0.4rem 0.6rem;
  }
  .error {
    color: #b00020;
    font-size: 0.85rem;
  }
  .link {
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
  }
  .preview {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
  }
  .preview-frame {
    flex: 1 1 auto;
    width: 100%;
    min-height: 70vh;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    /* Kept white: the iframe renders the post as it appears on the (light) published page. */
    background: #fff;
  }
</style>
