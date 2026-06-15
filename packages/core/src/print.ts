/**
 * Print Design template engine.
 *
 * Renders a user-authored HTML template against a {@link PrintRecord} using a small,
 * mustache-like `{{ }}` syntax. Pure and framework-agnostic: the browser UI renders the
 * result inside a sandboxed iframe and prints it (see planning doc 04-print-design).
 *
 * Syntax:
 *   - `{{ path }}`    resolve a dotted path, HTML-escape the value, and output it.
 *   - `{{{ path }}}`  same, but output the value raw (no escaping) for HTML fields such as
 *                     `content` / `excerpt`, which already hold WordPress-rendered HTML.
 *   - `{{#each path}} ... {{/each}}`  iterate an array; inside the block, `this` is the
 *                     current item (and `this.<key>` reaches into an object item).
 *
 * Unknown paths render as the empty string. Paths resolve against the record, except
 * `this` / `this.<key>`, which resolve against the current `{{#each}}` item.
 */

import type { WpPostResponse } from './types';

/** The data a template is rendered against (one WordPress post, flattened for templating). */
export interface PrintRecord {
  id: number;
  title: string;
  /** WordPress-rendered HTML. Use `{{{ content }}}` so it is not escaped. */
  content: string;
  /** WordPress-rendered HTML. Use `{{{ excerpt }}}` so it is not escaped. */
  excerpt: string;
  status: string;
  menuOrder: number;
  /** Absolute URL of the featured image, or `''` when the post has none. */
  featuredImageUrl: string;
  /**
   * Flattened post meta, keyed by meta key (values stringified; arrays joined with `, `).
   * Reachable in templates as `{{ meta.<key> }}`. A meta key containing a literal dot
   * cannot be addressed, since template paths split on `.`.
   */
  meta: Record<string, string>;
  /** Taxonomy terms keyed by REST base (e.g. `tax.category`), each an array of term names. */
  tax: Record<string, string[]>;
}

/** Thrown when a template has an unbalanced `{{#each}}` / `{{/each}}`. */
export class TemplateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateParseError';
  }
}

type TemplateNode = TextNode | VarNode | EachNode;
interface TextNode {
  kind: 'text';
  value: string;
}
interface VarNode {
  kind: 'var';
  path: string;
  /** `true` for triple-brace `{{{ }}}` (unescaped) output. */
  raw: boolean;
}
interface EachNode {
  kind: 'each';
  path: string;
  body: TemplateNode[];
}

interface Scope {
  /** The record paths resolve against by default. */
  record: PrintRecord;
  /** The current `{{#each}}` item, reachable as `this` / `this.<key>`. */
  current?: unknown;
}

// Order matters: triple-brace and the each tags must be tried before the generic `{{ }}`.
// `[\s\S]` (not `.`) so a tag may span newlines.
const TAG =
  /(\{\{\{\s*([\s\S]+?)\s*\}\}\})|(\{\{\s*#each\s+([\s\S]+?)\s*\}\})|(\{\{\s*\/each\s*\}\})|(\{\{\s*([\s\S]+?)\s*\}\})/g;

/** Parse a template string into a node tree, validating `{{#each}}` nesting. */
function parseTemplate(template: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  // `current` is the node list we append to; `parents` lets us pop back out of an each
  // block; `open` tracks open each blocks so we can detect unbalanced tags.
  let current: TemplateNode[] = root;
  const parents: TemplateNode[][] = [];
  const open: EachNode[] = [];
  const pushText = (text: string): void => {
    if (text) current.push({ kind: 'text', value: text });
  };

  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(template)) !== null) {
    pushText(template.slice(last, m.index));
    last = TAG.lastIndex;
    if (m[2] !== undefined) {
      // {{{ raw }}}
      current.push({ kind: 'var', path: m[2].trim(), raw: true });
    } else if (m[4] !== undefined) {
      // {{#each path}}
      const node: EachNode = { kind: 'each', path: m[4].trim(), body: [] };
      current.push(node);
      parents.push(current);
      current = node.body;
      open.push(node);
    } else if (m[5] !== undefined) {
      // {{/each}}
      if (open.length === 0) {
        throw new TemplateParseError('Unexpected {{/each}} without a matching {{#each}}.');
      }
      open.pop();
      current = parents.pop() ?? root;
    } else if (m[7] !== undefined) {
      // {{ var }}
      current.push({ kind: 'var', path: m[7].trim(), raw: false });
    }
  }
  pushText(template.slice(last));

  if (open.length > 0) {
    const unclosed = open[open.length - 1];
    throw new TemplateParseError(`Unclosed {{#each ${unclosed ? unclosed.path : ''}}}.`);
  }
  return root;
}

/** Walk a dotted path (e.g. `meta.price`) into a value, returning `undefined` if any hop misses. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Resolve a template path against the scope. `this` / `this.<key>` target the each item. */
function resolve(path: string, scope: Scope): unknown {
  if (path === 'this') {
    return scope.current;
  }
  if (path.startsWith('this.')) {
    return getPath(scope.current, path.slice('this.'.length));
  }
  return getPath(scope.record, path);
}

/** Stringify a scalar for output; non-scalars (objects/arrays) and nullish render as ''. */
function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects/arrays have no sensible inline string form; render nothing.
  return '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNodes(nodes: TemplateNode[], scope: Scope): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value;
    } else if (node.kind === 'var') {
      const value = resolve(node.path, scope);
      out += node.raw ? stringifyScalar(value) : escapeHtml(stringifyScalar(value));
    } else {
      // each: iterate only when the path resolves to an array; otherwise render nothing.
      const list = resolve(node.path, scope);
      if (Array.isArray(list)) {
        for (const item of list) {
          out += renderNodes(node.body, { record: scope.record, current: item });
        }
      }
    }
  }
  return out;
}

/**
 * Render a Print Design template against one record. Values are HTML-escaped for `{{ }}`
 * and emitted raw for `{{{ }}}`. Throws {@link TemplateParseError} on unbalanced
 * `{{#each}}` / `{{/each}}`.
 */
export function renderTemplate(template: string, record: PrintRecord): string {
  return renderNodes(parseTemplate(template), { record });
}

/** Flatten one meta value to a string. Arrays join their non-empty scalar parts. */
function flattenMetaValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(stringifyScalar)
      .filter((s) => s !== '')
      .join(', ');
  }
  return stringifyScalar(value);
}

/** Merge core meta and connector meta (connector wins) into flat string values. */
function flattenMeta(raw: WpPostResponse): Record<string, string> {
  // Null-proto so untrusted meta keys (e.g. `__proto__`, `constructor`) become plain own
  // entries with no prototype pollution and no inherited-key collisions.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const add = (src: Record<string, unknown> | undefined): void => {
    if (!src) return;
    for (const [key, value] of Object.entries(src)) {
      out[key] = flattenMetaValue(value);
    }
  };
  add(raw.meta);
  add(raw.dbp_wp_meta); // connector meta overlays core meta for the same key
  return out;
}

/** Extract the featured image URL from an `_embed`ded response, or '' when absent. */
function extractFeaturedImageUrl(embedded: WpPostResponse['_embedded']): string {
  const media = embedded?.['wp:featuredmedia'];
  if (Array.isArray(media) && media.length > 0) {
    const first = media[0];
    if (first !== null && typeof first === 'object') {
      const sourceUrl = (first as Record<string, unknown>).source_url;
      if (typeof sourceUrl === 'string') {
        return sourceUrl;
      }
    }
  }
  return '';
}

/** Group `_embed`ded terms into `{ <taxonomy slug>: [term name, ...] }`. */
function extractTerms(embedded: WpPostResponse['_embedded']): Record<string, string[]> {
  // Null-proto so a taxonomy slug like `toString`/`__proto__` cannot resolve an inherited
  // value (which would make `(tax[slug] ??= [])` skip the array and throw on `.push`).
  const tax: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const groups = embedded?.['wp:term'];
  if (!Array.isArray(groups)) {
    return tax;
  }
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const term of group) {
      if (term === null || typeof term !== 'object') continue;
      const entry = term as Record<string, unknown>;
      if (typeof entry.taxonomy === 'string' && typeof entry.name === 'string') {
        (tax[entry.taxonomy] ??= []).push(entry.name);
      }
    }
  }
  return tax;
}

/**
 * Build a {@link PrintRecord} from a raw WordPress REST post. Expects the request to have
 * used `context=edit` and `_embed` so `content`/`excerpt` and embedded media/terms are
 * present; missing pieces degrade to empty values rather than throwing.
 *
 * `title` uses the raw (unescaped) value so `{{ title }}` escaping is not doubled.
 * `content`/`excerpt` use the rendered HTML (intended for `{{{ }}}`).
 */
export function buildPrintRecord(raw: WpPostResponse): PrintRecord {
  return {
    id: raw.id,
    title: raw.title?.raw ?? raw.title?.rendered ?? '',
    content: raw.content?.rendered ?? '',
    excerpt: raw.excerpt?.rendered ?? '',
    status: raw.status,
    menuOrder: raw.menu_order,
    featuredImageUrl: extractFeaturedImageUrl(raw._embedded),
    meta: flattenMeta(raw),
    tax: extractTerms(raw._embedded),
  };
}
