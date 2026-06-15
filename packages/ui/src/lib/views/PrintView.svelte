<script lang="ts">
  import { onMount } from 'svelte';
  import { renderTemplate, type PrintRecord } from '@dbp-wp/core';
  import { fetchPrintRecords } from '../api';

  let {
    type,
    connectorAvailable,
  }: {
    type: string;
    connectorAvailable: boolean;
  } = $props();

  const DEFAULT_TEMPLATE = `<article>
  <h2>{{ title }}</h2>
  {{{ excerpt }}}
</article>`;

  const DEFAULT_CSS = `article {
  border: 1px solid #ccc;
  padding: 8mm;
  font-family: serif;
}
h2 {
  margin: 0 0 4mm;
  font-size: 14pt;
}`;

  let records = $state<PrintRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let template = $state(DEFAULT_TEMPLATE);
  let css = $state(DEFAULT_CSS);
  let paper = $state<'a4-portrait' | 'a4-landscape'>('a4-portrait');
  let margin = $state(15);
  let columns = $state(1);

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  // True once the iframe has finished loading the CURRENT document, so Print never fires
  // against a stale or not-yet-rendered srcdoc.
  let frameReady = $state(false);

  // Clamp the values that get interpolated into CSS so a stray number can't inject markup.
  const safeMargin = $derived(Math.min(50, Math.max(0, Math.round(Number(margin) || 0))));
  const safeColumns = $derived(Math.min(4, Math.max(1, Math.round(Number(columns) || 1))));

  // Build the full, self-contained print document. Page breaks are left to the browser's
  // print engine (`@page` + `break-inside: avoid`), per planning doc 04-print-design.
  function buildDoc(opts: {
    orientation: 'portrait' | 'landscape';
    margin: number;
    columns: number;
    userCss: string;
    body: string;
  }): string {
    const base = `
    @page { size: A4 ${opts.orientation}; margin: ${opts.margin}mm; }
    html, body { margin: 0; padding: 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .dbp-print-grid { display: grid; grid-template-columns: repeat(${opts.columns}, 1fr); gap: 4mm; padding: 4mm; }
    .dbp-print-item { break-inside: avoid; }
    img { max-width: 100%; }`;
    // Prevent a stray `</style>` in user CSS from closing the tag early. Scripts can't run
    // anyway (the preview iframe is sandboxed without allow-scripts), but keep it tidy.
    const userCss = opts.userCss.replace(/<\/style/gi, '<\\/style');
    return `<!doctype html><html><head><meta charset="utf-8"><style>${base}\n${userCss}</style></head><body><div class="dbp-print-grid">${opts.body}</div></body></html>`;
  }

  // Render every record through the template ONCE. Depends only on `template` + `records`,
  // so editing CSS / margin / columns does not re-run the per-record rendering. A template
  // parse error is surfaced instead of thrown so editing stays live.
  const renderedBody = $derived.by((): { body: string; error: string | null } => {
    if (records.length === 0) {
      return { body: '', error: null };
    }
    try {
      const body = records
        .map((r) => `<section class="dbp-print-item">${renderTemplate(template, r)}</section>`)
        .join('\n');
      return { body, error: null };
    } catch (e) {
      return { body: '', error: e instanceof Error ? e.message : 'Template error' };
    }
  });

  // Wrap the rendered body in the page document. Depends on the body + page controls/CSS,
  // so control/CSS edits only re-wrap (cheap) rather than re-render every record.
  const doc = $derived.by((): { html: string; error: string | null } => {
    if (renderedBody.error !== null) {
      return { html: '', error: renderedBody.error };
    }
    if (records.length === 0) {
      return { html: '', error: null };
    }
    const orientation = paper === 'a4-landscape' ? 'landscape' : 'portrait';
    return {
      html: buildDoc({
        orientation,
        margin: safeMargin,
        columns: safeColumns,
        userCss: css,
        body: renderedBody.body,
      }),
      error: null,
    };
  });

  // The iframe reloads whenever its srcdoc changes; clear readiness here and let the
  // iframe's load event re-arm it, so Print can't fire against an in-flight document.
  $effect(() => {
    void doc.html;
    frameReady = false;
  });

  const canPrint = $derived(
    !loading && loadError === null && records.length > 0 && doc.error === null && frameReady,
  );

  function doPrint(): void {
    const win = iframeEl?.contentWindow;
    if (!win) {
      return;
    }
    win.focus();
    win.print();
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const res = await fetchPrintRecords({ type });
      records = res.unconfigured ? [] : res.records;
    } catch (e) {
      records = []; // don't leave a stale preview printable after a failed (re)load
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="print-view">
  <section class="panel">
    <p class="intro">
      Design a printable layout for <code>{type}</code> and print to PDF from your browser.
    </p>

    <label class="field">
      <span>Template (HTML)</span>
      <textarea bind:value={template} spellcheck="false" rows="8"></textarea>
    </label>

    <label class="field">
      <span>Styles (CSS)</span>
      <textarea bind:value={css} spellcheck="false" rows="8"></textarea>
    </label>

    <div class="controls">
      <label>
        Paper
        <select bind:value={paper}>
          <option value="a4-portrait">A4 portrait</option>
          <option value="a4-landscape">A4 landscape</option>
        </select>
      </label>
      <label>
        Columns
        <select bind:value={columns}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
          <option value={4}>4</option>
        </select>
      </label>
      <label>
        Margin (mm)
        <input type="number" bind:value={margin} min="0" max="50" step="1" />
      </label>
      <button onclick={doPrint} disabled={!canPrint}>Print…</button>
    </div>

    <details class="hint">
      <summary>Available fields</summary>
      <ul>
        <li><code>{'{{ title }}'}</code>, <code>{'{{ id }}'}</code>, <code>{'{{ status }}'}</code>,
          <code>{'{{ menuOrder }}'}</code></li>
        <li><code>{'{{{ content }}}'}</code>, <code>{'{{{ excerpt }}}'}</code> (HTML — use triple
          braces so they are not escaped)</li>
        <li><code>{'{{ featuredImageUrl }}'}</code></li>
        <li><code>{'{{ meta.<key> }}'}</code>{connectorAvailable ? '' : ' (custom meta needs the connector plugin)'}</li>
        <li><code>{'{{#each tax.<taxonomy>}}{{ this }}{{/each}}'}</code></li>
      </ul>
    </details>

    {#if loadError}
      <p class="error">{loadError} <button class="link" onclick={load}>Retry</button></p>
    {:else if !loading && records.length === 0}
      <p class="empty">No posts to lay out for <code>{type}</code>.</p>
    {:else if !loading}
      <p class="status">
        {records.length} record{records.length === 1 ? '' : 's'} loaded.
        {#if doc.error}<span class="error">Template error: {doc.error}</span>{/if}
      </p>
    {/if}
  </section>

  <section class="preview">
    {#if loading}
      <p>Loading…</p>
    {:else}
      <iframe
        title="Print preview"
        bind:this={iframeEl}
        srcdoc={doc.html}
        sandbox="allow-same-origin allow-modals"
        class="preview-frame"
        onload={() => (frameReady = true)}
      ></iframe>
    {/if}
  </section>
</div>

<style>
  .print-view {
    display: flex;
    gap: 1rem;
    align-items: stretch;
  }
  .panel {
    flex: 0 0 22rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
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
  .intro {
    margin: 0;
    font-size: 0.9rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
  }
  .field textarea {
    font-family: monospace;
    font-size: 0.8rem;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
  }
  .controls label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.8rem;
  }
  .controls input[type='number'] {
    width: 5rem;
  }
  .hint {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .hint ul {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
  }
  .hint li {
    margin: 0.2rem 0;
  }
  .status {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.8;
  }
  .link {
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
  }
</style>
