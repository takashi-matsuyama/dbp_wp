<script lang="ts">
  import {
    buildImportPlan,
    parseCsv,
    parseJsonRecords,
    type ImportTarget,
    type ParsedTable,
  } from '@dbp-wp/core';
  import { importPosts, type ImportCreateInput } from '../api';

  let {
    type,
    connectorAvailable,
    onimported,
  }: {
    type: string;
    connectorAvailable: boolean;
    onimported: () => void | Promise<void>;
  } = $props();

  // Send creates in chunks so a large file stays under the CLI's request-body limit.
  const CHUNK_SIZE = 500;
  // How many data rows to show in the confirmation preview.
  const PREVIEW_ROWS = 20;

  let fileName = $state<string | null>(null);
  let table = $state<ParsedTable | null>(null);
  let mapping = $state<ImportTarget[]>([]);
  let parseError = $state<string | null>(null);

  let importing = $state(false);
  let progress = $state<{ done: number; total: number } | null>(null);
  let error = $state<string | null>(null);
  let summary = $state<{ created: number; failed: number; errors: string[] } | null>(null);

  function defaultTarget(header: string): ImportTarget {
    const h = header.trim().toLowerCase();
    if (h === 'title') {
      return { kind: 'title' };
    }
    if (h === 'status') {
      return { kind: 'status' };
    }
    if (h === 'menu_order' || h === 'menuorder' || h === 'order') {
      return { kind: 'menuOrder' };
    }
    return { kind: 'skip' };
  }

  async function onFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    parseError = null;
    summary = null;
    error = null;
    try {
      const text = await file.text();
      const isJson = file.name.toLowerCase().endsWith('.json') || file.type.includes('json');
      const parsed = isJson ? parseJsonRecords(text) : parseCsv(text);
      fileName = file.name;
      table = parsed;
      mapping = parsed.headers.map(defaultTarget);
    } catch (e) {
      table = null;
      mapping = [];
      fileName = file.name;
      parseError = e instanceof Error ? e.message : 'Could not parse the file.';
    }
  }

  function setTarget(col: number, kind: string): void {
    const header = table?.headers[col] ?? '';
    let target: ImportTarget;
    switch (kind) {
      case 'title':
        target = { kind: 'title' };
        break;
      case 'status':
        target = { kind: 'status' };
        break;
      case 'menuOrder':
        target = { kind: 'menuOrder' };
        break;
      case 'meta':
        target = { kind: 'meta', key: header };
        break;
      default:
        target = { kind: 'skip' };
    }
    mapping[col] = target;
    mapping = [...mapping];
  }

  function targetKey(target: ImportTarget): string | null {
    switch (target.kind) {
      case 'title':
      case 'status':
      case 'menuOrder':
        return target.kind;
      case 'meta':
        return `meta:${target.key}`;
      default:
        return null;
    }
  }

  function targetLabel(target: ImportTarget): string {
    switch (target.kind) {
      case 'title':
        return 'Title';
      case 'status':
        return 'Status';
      case 'menuOrder':
        return 'Menu order';
      case 'meta':
        return `Custom: ${target.key}`;
      default:
        return '';
    }
  }

  // Targets mapped by more than one column (each standard field, and each meta key, must
  // be unique). A non-empty list blocks the import.
  const conflicts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const target of mapping) {
      const key = targetKey(target);
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key);
  });

  // Columns that map to something (for the preview header/rows), paired with their target.
  const mappedColumns = $derived(
    mapping.flatMap((target, col) => (target.kind === 'skip' ? [] : [{ col, target }])),
  );

  // The new posts that would be created (empty cells/rows are dropped by the planner).
  const plan = $derived(table ? buildImportPlan(table, mapping) : []);

  const canImport = $derived(
    !importing && plan.length > 0 && conflicts.length === 0 && mappedColumns.length > 0,
  );

  function reset(): void {
    table = null;
    mapping = [];
    fileName = null;
    parseError = null;
    summary = null;
    error = null;
  }

  async function runImport(): Promise<void> {
    if (!canImport) {
      return;
    }
    importing = true;
    error = null;
    summary = null;
    const creates: ImportCreateInput[] = plan.map((create) => ({
      ...create.fields,
      ...(create.meta ? { meta: create.meta } : {}),
    }));
    let created = 0;
    const errors: string[] = [];
    try {
      for (let i = 0; i < creates.length; i += CHUNK_SIZE) {
        const results = await importPosts(creates.slice(i, i + CHUNK_SIZE), type);
        for (const result of results) {
          if (result.ok) {
            created += 1;
          } else {
            errors.push(result.error ?? 'Create failed');
          }
        }
        progress = { done: Math.min(i + CHUNK_SIZE, creates.length), total: creates.length };
      }
      summary = { created, failed: errors.length, errors: errors.slice(0, 10) };
      if (created > 0) {
        await onimported();
      }
    } catch (e) {
      // A chunk failed mid-run. Surface a partial summary (and refresh) so the user knows
      // what was already created and does not blindly retry the whole file, duplicating it.
      error = e instanceof Error ? e.message : String(e);
      if (created > 0 || errors.length > 0) {
        summary = { created, failed: errors.length, errors: errors.slice(0, 10) };
      }
      if (created > 0) {
        await onimported();
      }
    } finally {
      importing = false;
      progress = null;
    }
  }
</script>

<div class="import-view">
  <div class="step">
    <p>Import new posts from a CSV or JSON file into <code>{type}</code>.</p>
    <input type="file" accept=".csv,.json,text/csv,application/json" onchange={onFile} />
    {#if fileName}<span class="file-name">{fileName}</span>{/if}
    {#if table}<button class="link" onclick={reset} disabled={importing}>Clear</button>{/if}
  </div>

  {#if parseError}
    <p class="error">{parseError}</p>
  {/if}

  {#if !connectorAvailable}
    <p class="restricted-note">
      Restricted mode: custom fields (meta) need the DBP WP Connector plugin. Title, status, and
      menu order still import.
    </p>
  {/if}

  {#if table}
    {#if table.headers.length === 0}
      <p class="empty">No columns found in the file.</p>
    {:else}
      <div class="mapping">
        <h3>Map columns</h3>
        <ul class="column-list">
          {#each table.headers as header, col (col)}
            <li>
              <span class="source-col" title={header}>{header || '(empty header)'}</span>
              <span class="arrow">→</span>
              <select
                value={mapping[col]?.kind ?? 'skip'}
                disabled={importing}
                onchange={(e) => setTarget(col, (e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="skip">Skip</option>
                <option value="title">Title</option>
                <option value="status">Status</option>
                <option value="menuOrder">Menu order</option>
                <option value="meta" disabled={!connectorAvailable}>
                  Custom field{connectorAvailable ? '' : ' (needs connector)'}
                </option>
              </select>
            </li>
          {/each}
        </ul>
      </div>

      {#if conflicts.length > 0}
        <p class="error">Each target can be mapped only once. Conflicting: {conflicts.join(', ')}.</p>
      {/if}

      {#if mappedColumns.length === 0}
        <p class="hint">Map at least one column to import.</p>
      {:else}
        <div class="preview">
          <h3>
            Preview — {plan.length} post{plan.length === 1 ? '' : 's'} from {table.rows.length} row{table
              .rows.length === 1
              ? ''
              : 's'}
          </h3>
          <div class="table-wrap">
            <table class="sheet">
              <thead>
                <tr>
                  {#each mappedColumns as mc (mc.col)}
                    <th>{targetLabel(mc.target)}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each table.rows.slice(0, PREVIEW_ROWS) as row, r (r)}
                  <tr>
                    {#each mappedColumns as mc (mc.col)}
                      <td>{row[mc.col] ?? ''}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if table.rows.length > PREVIEW_ROWS}
            <p class="hint">Showing the first {PREVIEW_ROWS} rows.</p>
          {/if}
        </div>

        <div class="actions">
          <button onclick={runImport} disabled={!canImport}>
            {importing ? 'Importing…' : `Import ${plan.length} post${plan.length === 1 ? '' : 's'}`}
          </button>
          {#if progress}
            <span class="hint">{progress.done} / {progress.total}</span>
          {/if}
          {#if error}<span class="error">{error}</span>{/if}
        </div>
      {/if}
    {/if}
  {/if}

  {#if summary}
    <div class="summary">
      <p>
        Created {summary.created} post{summary.created === 1 ? '' : 's'}.
        {#if summary.failed > 0}<span class="error">{summary.failed} failed.</span>{/if}
      </p>
      {#if summary.errors.length > 0}
        <ul class="error-list">
          {#each summary.errors as message, i (i)}
            <li class="error">{message}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .import-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .file-name {
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
  .restricted-note {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .column-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .column-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .source-col {
    min-width: 12rem;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
  }
  .arrow {
    opacity: 0.5;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .hint {
    font-size: 0.85rem;
    opacity: 0.7;
  }
  .error-list {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
    font-size: 0.85rem;
  }
</style>
