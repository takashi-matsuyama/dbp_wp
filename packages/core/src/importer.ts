import type { UpdatePostFields } from './types';

// WordPress stores menu_order in a signed 32-bit column; ignore cells outside that range
// so one bad value does not get the whole server-side chunk rejected.
const MENU_ORDER_MIN = -2_147_483_648;
const MENU_ORDER_MAX = 2_147_483_647;

/**
 * A tabular view of an import file: a header row plus data rows. Both CSV and JSON
 * sources are normalized to this shape so the column-mapping logic is source-agnostic.
 * Each data row is aligned to `headers` by index; a short row has missing trailing cells.
 */
export interface ParsedTable {
  /** Column headers (CSV first row, or the union of JSON object keys). */
  headers: string[];
  /** Data rows; `rows[r][c]` is the cell under `headers[c]`. */
  rows: string[][];
}

/**
 * Where a file column is imported to. `skip` drops the column; `title`/`status`/
 * `menuOrder` map to standard post fields; `meta` writes an arbitrary post-meta key
 * (companion plugin required).
 */
export type ImportTarget =
  | { kind: 'skip' }
  | { kind: 'title' }
  | { kind: 'status' }
  | { kind: 'menuOrder' }
  | { kind: 'meta'; key: string };

/** A single new post to create, derived from one import row. */
export interface ImportCreate {
  /** Standard fields (title / menuOrder / status). */
  fields: UpdatePostFields;
  /** Arbitrary meta to write via the companion plugin (omitted when none). */
  meta?: Record<string, unknown>;
}

/**
 * Parse CSV text into a table, taking the first record as headers. Implements the
 * RFC 4180 essentials: double-quoted fields, embedded commas/newlines, `""` escapes,
 * and CRLF or LF line endings. A trailing newline does not produce an empty record.
 */
export function parseCsv(text: string): ParsedTable {
  const records = parseCsvRecords(text);
  const headers = records[0] ?? [];
  return { headers, rows: records.slice(1) };
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      endRecord();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // An unclosed quote means the file is malformed; surface it rather than silently
  // merging the rest of the file into one field and writing corrupted data.
  if (inQuotes) {
    throw new Error('Malformed CSV: unterminated quoted field.');
  }
  // Flush a final record only if there is pending content (no trailing-newline ghost row).
  if (field !== '' || record.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * Parse JSON text (an array of objects) into a table. Headers are the union of all
 * object keys in first-seen order. Object/array cell values are JSON-stringified;
 * null and undefined become an empty string. Throws if the JSON is not an array.
 */
export function parseJsonRecords(text: string): ParsedTable {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('JSON import must be an array of objects.');
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (isPlainRecord(entry)) {
      for (const key of Object.keys(entry)) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
  }
  const rows = data.map((entry) => {
    const record = isPlainRecord(entry) ? entry : {};
    return headers.map((header) => stringifyCell(record[header]));
  });
  return { headers, rows };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Known post-status values and English/value labels, mapped to the WordPress status.
 * A null-prototype map so inherited keys (`constructor`, `toString`, `__proto__`, …) do
 * not accidentally resolve to a function/object instead of falling back to the raw value.
 */
const STATUS_LABELS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    publish: 'publish',
    published: 'publish',
    draft: 'draft',
    pending: 'pending',
    private: 'private',
    future: 'future',
  },
);

/**
 * Normalize a status cell to a WordPress status. Known labels/values (case-insensitive,
 * e.g. `Published` → `publish`) are mapped; anything else passes through trimmed so the
 * WordPress REST API can validate it and surface a per-row error if invalid.
 */
export function normalizeStatus(value: string): string {
  const trimmed = value.trim();
  return STATUS_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Apply a column mapping to a parsed table, producing one {@link ImportCreate} per row.
 * Empty cells contribute nothing; a row that maps to no fields and no meta is skipped.
 * Non-integer `menuOrder` cells are ignored. Meta is stored on a null-prototype object
 * so a header named `__proto__` is kept as data, never touching any prototype.
 */
export function buildImportPlan(table: ParsedTable, mapping: ImportTarget[]): ImportCreate[] {
  const creates: ImportCreate[] = [];
  for (const row of table.rows) {
    const fields: UpdatePostFields = {};
    let meta: Record<string, unknown> | undefined;

    for (let col = 0; col < mapping.length; col += 1) {
      const target = mapping[col];
      if (!target || target.kind === 'skip') {
        continue;
      }
      const value = row[col] ?? '';
      if (value === '') {
        continue;
      }
      switch (target.kind) {
        case 'title':
          fields.title = value;
          break;
        case 'status':
          fields.status = normalizeStatus(value);
          break;
        case 'menuOrder': {
          const order = Number(value);
          if (Number.isInteger(order) && order >= MENU_ORDER_MIN && order <= MENU_ORDER_MAX) {
            fields.menuOrder = order;
          }
          break;
        }
        case 'meta':
          // An empty/whitespace meta key would be rejected by the server (empty key),
          // failing the whole chunk; skip it rather than emit `meta[""]`.
          if (target.key.trim() === '') {
            break;
          }
          if (!meta) {
            meta = Object.create(null) as Record<string, unknown>;
          }
          meta[target.key] = value;
          break;
      }
    }

    if (meta !== undefined && Object.keys(meta).length > 0) {
      creates.push({ fields, meta });
    } else if (Object.keys(fields).length > 0) {
      creates.push({ fields });
    }
  }
  return creates;
}
