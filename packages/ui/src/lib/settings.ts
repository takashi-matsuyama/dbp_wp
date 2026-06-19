// Per-(site, post type) spreadsheet column settings, persisted in the browser's
// localStorage. The full app (served at a stable localhost origin, default port 4317) and
// the browser demo (a same-origin iframe) both use this identical mechanism — no CLI,
// connector, or network involvement. This is the local home for the column/label settings
// the legacy SaaS kept in WP usermeta (planning 00 §4: "UI 設定はローカル保存に移す").

const STORAGE_PREFIX = 'dbp-wp:cols:';
const SCHEMA_VERSION = 1;

/** One shown meta column: the meta key it maps to plus its display label. */
export interface ColumnSetting {
  /** Meta key this column maps to (its immutable identity). */
  key: string;
  /** Display label shown in the column header (defaults to the key). */
  label: string;
}

/** The persisted column configuration for one (site, post type). */
export interface ColumnSettings {
  /** Shown meta columns, in display order. */
  columns: ColumnSetting[];
  /** The child-data (relation aggregation) template, or '' when unset. */
  childTemplate: string;
}

function empty(): ColumnSettings {
  return { columns: [], childTemplate: '' };
}

function storageKey(siteUrl: string | null, type: string): string {
  // A null site (demo / not yet connected) shares one 'demo' namespace.
  return `${STORAGE_PREFIX}${siteUrl ?? 'demo'}:${type}`;
}

/**
 * Parse and validate a stored JSON payload into {@link ColumnSettings}, defensively against
 * tampering or an older/newer schema: non-string keys, blanks, and duplicates are dropped,
 * and a missing/!string `childTemplate` becomes ''. Never throws — returns empties on any
 * malformed input. The result is built without an object map keyed by untrusted strings, so
 * there is no prototype-pollution surface.
 */
export function parseColumnSettings(raw: string): ColumnSettings {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (data === null || typeof data !== 'object') {
    return empty();
  }
  const obj = data as Record<string, unknown>;
  // Read only own properties: a JSON object inherits from Object.prototype, so an unrelated
  // prototype pollution elsewhere on the page must not be mistaken for stored settings.
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  const columns: ColumnSetting[] = [];
  const seen = new Set<string>();
  const rawColumns = own('columns');
  if (Array.isArray(rawColumns)) {
    for (const entry of rawColumns) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const rawKey = Object.prototype.hasOwnProperty.call(e, 'key') ? e.key : undefined;
      const key = typeof rawKey === 'string' ? rawKey : '';
      if (key === '' || seen.has(key)) {
        continue; // skip blank or duplicate keys
      }
      seen.add(key);
      const rawLabel = Object.prototype.hasOwnProperty.call(e, 'label') ? e.label : undefined;
      const label = typeof rawLabel === 'string' && rawLabel !== '' ? rawLabel : key;
      columns.push({ key, label });
    }
  }
  const rawTemplate = own('childTemplate');
  const childTemplate = typeof rawTemplate === 'string' ? rawTemplate : '';
  return { columns, childTemplate };
}

/** Read the saved column settings for a (site, type), or empties. Never throws. */
export function loadColumnSettings(siteUrl: string | null, type: string): ColumnSettings {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(storageKey(siteUrl, type)) ?? null;
  } catch {
    return empty(); // storage unavailable (e.g. privacy mode)
  }
  return raw === null ? empty() : parseColumnSettings(raw);
}

/** Persist column settings for a (site, type). Never throws (storage may be unavailable). */
export function saveColumnSettings(
  siteUrl: string | null,
  type: string,
  settings: ColumnSettings,
): void {
  try {
    const payload = JSON.stringify({
      version: SCHEMA_VERSION,
      columns: settings.columns.map((c) => ({ key: c.key, label: c.label })),
      childTemplate: settings.childTemplate,
    });
    globalThis.localStorage?.setItem(storageKey(siteUrl, type), payload);
  } catch {
    // Storage unavailable / over quota — settings just won't persist this session.
  }
}
