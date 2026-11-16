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
  record: object;
  /** The current `{{#each}}` item, reachable as `this` / `this.<key>`. */
  current?: unknown;
}

/** One template tag found by {@link scanTags}: `template.slice(start, end)` is the whole tag. */
export interface TemplateTag {
  kind: 'raw' | 'each' | 'endEach' | 'var';
  start: number;
  end: number;
  /** The tag's path, trimmed (`''` for `endEach`). */
  path: string;
}

const WHITESPACE = /\s/;

/**
 * Find the template tags, left to right, in linear time.
 *
 * The result is exactly what this regex returned (as a global `exec` loop, with the
 * alternatives tried in this order at each position):
 *
 *   /(\{\{\{\s*([\s\S]+?)\s*\}\}\})|(\{\{\s*#each\s+([\s\S]+?)\s*\}\})|(\{\{\s*\/each\s*\}\})|(\{\{\s*([\s\S]+?)\s*\}\})/g
 *
 * That regex backtracked polynomially on unclosed tags (e.g. `{{{{` followed by a long run
 * of spaces took about a minute for 5,000 spaces). Here every alternative is decided in
 * constant time from lookup tables built in one pass, and only `{{` positions are tried.
 */
export function scanTags(template: string): TemplateTag[] {
  const n = template.length;
  // wsEnd[i]: the first index >= i that is not whitespace (`\s`), or n.
  const wsEnd = new Int32Array(n + 1);
  wsEnd[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    wsEnd[i] = WHITESPACE.test(template.charAt(i)) ? (wsEnd[i + 1] ?? n) : i;
  }
  // next2[i] / next3[i]: the first index >= i where `}}` / `}}}` starts, or -1.
  const next2 = new Int32Array(n + 2).fill(-1);
  const next3 = new Int32Array(n + 2).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    next2[i] = template.startsWith('}}', i) ? i : (next2[i + 1] ?? -1);
    next3[i] = template.startsWith('}}}', i) ? i : (next3[i + 1] ?? -1);
  }
  const at = (table: Int32Array, i: number): number => table[i] ?? -1;

  // The body of a tag: a leading whitespace run (now ending at `s`, `lead` long), then a lazy
  // body, optional whitespace, and the closer. With the longest leading run the regex closes
  // at the first closer that starts at least one character after `s`. When there is none it
  // gives leading whitespace back to the body, which can only succeed when a closer starts at
  // `s` itself; the body is then one whitespace character, so the path is empty. `minLead` is
  // the shortest leading run the pattern allows (0 for `\s*`, 1 for `\s+`).
  const closeBody = (
    s: number,
    lead: number,
    minLead: number,
    next: Int32Array,
    closeLength: number,
  ): { end: number; path: string } | null => {
    const close = at(next, s + 1);
    if (close !== -1) {
      return { end: close + closeLength, path: template.slice(s, close).trim() };
    }
    if (lead > minLead && at(next, s) === s) {
      return { end: s + closeLength, path: '' };
    }
    return null;
  };

  const matchAt = (p: number): TemplateTag | null => {
    // {{{ raw }}}
    if (template.startsWith('{{{', p)) {
      const s = at(wsEnd, p + 3);
      const body = closeBody(s, s - (p + 3), 0, next3, 3);
      if (body) return { kind: 'raw', start: p, ...body };
    }
    const a = at(wsEnd, p + 2);
    // {{#each path}}
    if (template.startsWith('#each', a)) {
      const s = at(wsEnd, a + 5);
      const lead = s - (a + 5);
      if (lead >= 1) {
        const body = closeBody(s, lead, 1, next2, 2);
        if (body) return { kind: 'each', start: p, ...body };
      }
    }
    // {{/each}}
    if (template.startsWith('/each', a)) {
      const b = at(wsEnd, a + 5);
      if (template.startsWith('}}', b)) return { kind: 'endEach', start: p, end: b + 2, path: '' };
    }
    // {{ var }}
    const body = closeBody(a, a - (p + 2), 0, next2, 2);
    return body ? { kind: 'var', start: p, ...body } : null;
  };

  const tags: TemplateTag[] = [];
  let p = template.indexOf('{{');
  while (p !== -1) {
    const tag = matchAt(p);
    if (tag) {
      tags.push(tag);
      p = template.indexOf('{{', tag.end);
    } else {
      p = template.indexOf('{{', p + 1);
    }
  }
  return tags;
}

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
  for (const tag of scanTags(template)) {
    pushText(template.slice(last, tag.start));
    last = tag.end;
    if (tag.kind === 'raw') {
      current.push({ kind: 'var', path: tag.path, raw: true });
    } else if (tag.kind === 'each') {
      const node: EachNode = { kind: 'each', path: tag.path, body: [] };
      current.push(node);
      parents.push(current);
      current = node.body;
      open.push(node);
    } else if (tag.kind === 'endEach') {
      if (open.length === 0) {
        throw new TemplateParseError('Unexpected {{/each}} without a matching {{#each}}.');
      }
      open.pop();
      current = parents.pop() ?? root;
    } else {
      current.push({ kind: 'var', path: tag.path, raw: false });
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

function renderNodes(nodes: TemplateNode[], scope: Scope, escape: boolean): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value;
    } else if (node.kind === 'var') {
      const value = stringifyScalar(resolve(node.path, scope));
      // `{{{ }}}` is always raw; `{{ }}` is HTML-escaped only in escaping (HTML) mode.
      out += node.raw || !escape ? value : escapeHtml(value);
    } else {
      // each: iterate only when the path resolves to an array; otherwise render nothing.
      const list = resolve(node.path, scope);
      if (Array.isArray(list)) {
        for (const item of list) {
          out += renderNodes(node.body, { record: scope.record, current: item }, escape);
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
  return renderNodes(parseTemplate(template), { record }, true);
}

/**
 * Render a template against an arbitrary record object, reusing the same `{{ }}` /
 * `{{#each}}` engine as {@link renderTemplate}. By default `{{ }}` values are HTML-escaped
 * (HTML output). Pass `escape: false` for a plain-text context (e.g. a spreadsheet cell
 * rendered as text, where the host already escapes for the DOM and re-escaping here would
 * surface literal entities). Throws {@link TemplateParseError} on unbalanced `{{#each}}`.
 */
export function renderRecordTemplate(
  template: string,
  record: object,
  options: { escape?: boolean } = {},
): string {
  return renderNodes(parseTemplate(template), { record }, options.escape ?? true);
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
