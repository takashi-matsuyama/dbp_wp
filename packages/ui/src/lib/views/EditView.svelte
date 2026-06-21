<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMarkdown } from '@dbp-wp/core';
  import { fetchPost, savePostBody } from '../api';

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

  function snapshot(): void {
    savedMarkdown = markdownText;
    savedHtml = htmlText;
    savedMode = mode;
  }

  const dirty = $derived(
    mode !== savedMode || markdownText !== savedMarkdown || htmlText !== savedHtml,
  );

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

<div class="edit-view">
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

      {#if mode === 'markdown'}
        <label class="field">
          <span>Markdown source</span>
          <textarea bind:value={markdownText} spellcheck="false" rows="18" disabled={saving}
          ></textarea>
        </label>
      {:else}
        <label class="field">
          <span>Body (HTML)</span>
          <textarea bind:value={htmlText} spellcheck="false" rows="18" disabled={saving}></textarea>
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
      </div>
    {/if}
  </section>

  <section class="preview">
    {#if loading}
      <p>Loading…</p>
    {:else}
      <iframe
        title="Body preview"
        srcdoc={previewDoc}
        sandbox="allow-same-origin"
        class="preview-frame"
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
    border: 1px solid #ccc;
    background: #f4f4f4;
    padding: 0.3rem 0.8rem;
    cursor: pointer;
  }
  .mode-tabs button.active {
    background: #fff;
    border-bottom-color: #fff;
    font-weight: bold;
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
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
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
    background: #fff7e6;
    border: 1px solid #f0c36d;
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
    border: 1px solid #ccc;
    background: #fff;
  }
</style>
