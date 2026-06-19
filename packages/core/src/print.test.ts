import { describe, expect, it } from 'vitest';
import {
  buildPrintRecord,
  renderRecordTemplate,
  renderTemplate,
  TemplateParseError,
  type PrintRecord,
} from './print';
import type { WpPostResponse } from './types';

function record(overrides: Partial<PrintRecord> = {}): PrintRecord {
  return {
    id: 1,
    title: 'Hello',
    content: '<p>Body</p>',
    excerpt: '<em>Sum</em>',
    status: 'publish',
    menuOrder: 3,
    featuredImageUrl: 'https://example.com/a.jpg',
    meta: { price: '1200', sku: 'A-1' },
    tax: { category: ['News', 'Tips'], post_tag: [] },
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('substitutes simple paths', () => {
    expect(renderTemplate('<h1>{{ title }}</h1>', record())).toBe('<h1>Hello</h1>');
    expect(renderTemplate('#{{ id }} order {{ menuOrder }}', record())).toBe('#1 order 3');
  });

  it('resolves dotted meta and joins nothing on its own', () => {
    expect(renderTemplate('{{ meta.price }} yen / {{ meta.sku }}', record())).toBe('1200 yen / A-1');
  });

  it('HTML-escapes {{ }} values but emits {{{ }}} raw', () => {
    const r = record({ title: 'A & B <x>', content: '<p>raw</p>' });
    expect(renderTemplate('{{ title }}', r)).toBe('A &amp; B &lt;x&gt;');
    expect(renderTemplate('{{{ content }}}', r)).toBe('<p>raw</p>');
    // The HTML field escaped (wrong usage) shows its tags as text:
    expect(renderTemplate('{{ content }}', r)).toBe('&lt;p&gt;raw&lt;/p&gt;');
  });

  it('renders unknown paths as empty string', () => {
    expect(renderTemplate('[{{ meta.nope }}][{{ missing }}][{{ tax.none }}]', record())).toBe('[][][]');
  });

  it('iterates arrays with {{#each}} and {{ this }}', () => {
    const out = renderTemplate('<ul>{{#each tax.category}}<li>{{ this }}</li>{{/each}}</ul>', record());
    expect(out).toBe('<ul><li>News</li><li>Tips</li></ul>');
  });

  it('renders nothing for {{#each}} over an empty or missing array', () => {
    expect(renderTemplate('a{{#each tax.post_tag}}<li>{{ this }}</li>{{/each}}b', record())).toBe('ab');
    expect(renderTemplate('a{{#each tax.missing}}x{{/each}}b', record())).toBe('ab');
    // A non-array scalar is not iterable -> nothing.
    expect(renderTemplate('a{{#each title}}x{{/each}}b', record())).toBe('ab');
  });

  it('escapes each-item values too, and supports this.<key>', () => {
    const r = record({ tax: { category: ['A & B'] } });
    expect(renderTemplate('{{#each tax.category}}{{ this }}{{/each}}', r)).toBe('A &amp; B');

    const r2 = { ...record(), tax: { items: [] } } as unknown as PrintRecord;
    // Object items: this.<key> reaches in. Cast through unknown since PrintRecord.tax is string[].
    (r2.tax as unknown as Record<string, unknown[]>).items = [{ name: 'X' }, { name: 'Y' }];
    expect(renderTemplate('{{#each tax.items}}[{{ this.name }}]{{/each}}', r2)).toBe('[X][Y]');
  });

  it('supports nested {{#each}} blocks', () => {
    const r = { ...record() } as unknown as Record<string, unknown>;
    r.tax = { groups: [{ terms: ['a', 'b'] }, { terms: ['c'] }] };
    const tpl = '{{#each tax.groups}}<g>{{#each this.terms}}{{ this }}{{/each}}</g>{{/each}}';
    expect(renderTemplate(tpl, r as unknown as PrintRecord)).toBe('<g>ab</g><g>c</g>');
  });

  it('preserves template text including newlines and braces in content', () => {
    const tpl = 'line1\n{{ title }}\nline3';
    expect(renderTemplate(tpl, record())).toBe('line1\nHello\nline3');
  });

  it('throws TemplateParseError on unbalanced each', () => {
    expect(() => renderTemplate('{{#each tax.category}}x', record())).toThrow(TemplateParseError);
    expect(() => renderTemplate('x{{/each}}', record())).toThrow(TemplateParseError);
  });
});

describe('renderRecordTemplate', () => {
  it('renders against an arbitrary record and escapes by default (like renderTemplate)', () => {
    expect(renderRecordTemplate('{{ name }}', { name: 'A & B' })).toBe('A &amp; B');
  });

  it('emits {{ }} raw (no HTML escaping) when escape is false', () => {
    expect(renderRecordTemplate('{{ name }}', { name: 'A & B' }, { escape: false })).toBe('A & B');
    // {{{ }}} is raw in either mode; the escape flag only changes {{ }}.
    expect(renderRecordTemplate('{{{ name }}}', { name: '<x>' }, { escape: false })).toBe('<x>');
  });

  it('iterates a children array with {{#each}} and this.<key>, unescaped', () => {
    const recordValue = {
      childCount: 2,
      children: [
        { title: 'A & B', meta: { price: '10' } },
        { title: 'C', meta: { price: '20' } },
      ],
    };
    const tpl = '{{ childCount }}: {{#each children}}{{ this.title }}={{ this.meta.price }};{{/each}}';
    expect(renderRecordTemplate(tpl, recordValue, { escape: false })).toBe('2: A & B=10;C=20;');
  });

  it('throws TemplateParseError on an unbalanced each', () => {
    expect(() => renderRecordTemplate('{{#each children}}x', {})).toThrow(TemplateParseError);
  });
});

describe('buildPrintRecord', () => {
  function raw(overrides: Partial<WpPostResponse> = {}): WpPostResponse {
    return {
      id: 7,
      type: 'post',
      status: 'publish',
      title: { rendered: 'R &amp; D', raw: 'R & D' },
      menu_order: 5,
      meta: { color: 'red', sizes: ['S', 'M'] },
      content: { rendered: '<p>body</p>', raw: 'body' },
      excerpt: { rendered: '<em>sum</em>' },
      _embedded: {
        'wp:featuredmedia': [{ source_url: 'https://example.com/img.png' }],
        'wp:term': [
          [
            { taxonomy: 'category', name: 'News' },
            { taxonomy: 'category', name: 'Tips' },
          ],
          [{ taxonomy: 'post_tag', name: 'alpha' }],
        ],
      },
      ...overrides,
    };
  }

  it('maps standard fields, preferring raw title and rendered content', () => {
    const r = buildPrintRecord(raw());
    expect(r.id).toBe(7);
    expect(r.title).toBe('R & D'); // raw, so {{ title }} escaping is not doubled
    expect(r.content).toBe('<p>body</p>'); // rendered HTML
    expect(r.excerpt).toBe('<em>sum</em>');
    expect(r.status).toBe('publish');
    expect(r.menuOrder).toBe(5);
  });

  it('extracts the featured image URL, or empty when absent/malformed', () => {
    expect(buildPrintRecord(raw()).featuredImageUrl).toBe('https://example.com/img.png');
    expect(buildPrintRecord(raw({ _embedded: {} })).featuredImageUrl).toBe('');
    // A media error object (no source_url) degrades to ''.
    expect(
      buildPrintRecord(raw({ _embedded: { 'wp:featuredmedia': [{ code: 'rest_forbidden' }] } }))
        .featuredImageUrl,
    ).toBe('');
  });

  it('groups embedded terms by taxonomy slug', () => {
    const r = buildPrintRecord(raw());
    expect(r.tax).toEqual({ category: ['News', 'Tips'], post_tag: ['alpha'] });
  });

  it('flattens meta to strings (arrays joined) and is renderable', () => {
    const r = buildPrintRecord(raw());
    expect(r.meta.color).toBe('red');
    expect(r.meta.sizes).toBe('S, M');
    expect(renderTemplate('{{ meta.color }} / {{ meta.sizes }}', r)).toBe('red / S, M');
  });

  it('lets connector meta (dbp_wp_meta) overlay core meta', () => {
    const r = buildPrintRecord(raw({ meta: { color: 'red' }, dbp_wp_meta: { color: 'blue', x: '1' } }));
    expect(r.meta.color).toBe('blue');
    expect(r.meta.x).toBe('1');
  });

  it('handles prototype-like meta keys without pollution or loss', () => {
    // Build via JSON.parse to mirror the real WP REST path: JSON.parse creates an OWN
    // `__proto__` property (unlike an object literal, where `__proto__:` is the proto
    // setter). This is exactly the case the null-proto accumulator must preserve.
    const meta = JSON.parse('{"__proto__":"p","constructor":"c","toString":"t","ok":"v"}') as Record<
      string,
      unknown
    >;
    const r = buildPrintRecord(raw({ meta }));
    expect(Object.prototype.hasOwnProperty.call(r.meta, '__proto__')).toBe(true);
    expect(r.meta['__proto__']).toBe('p');
    expect(r.meta.constructor).toBe('c');
    expect(r.meta.ok).toBe('v');
    // No global prototype pollution.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(renderTemplate('{{ meta.constructor }}/{{ meta.ok }}', r)).toBe('c/v');
  });

  it('groups prototype-like taxonomy slugs without throwing', () => {
    const r = buildPrintRecord(
      raw({
        _embedded: {
          'wp:term': [[{ taxonomy: 'toString', name: 'X' }, { taxonomy: '__proto__', name: 'Y' }]],
        },
      }),
    );
    expect(r.tax.toString).toEqual(['X']);
    expect(r.tax['__proto__']).toEqual(['Y']);
  });

  it('degrades a malformed/missing title to empty rather than throwing', () => {
    const malformed = { id: 9, type: 'post', status: 'draft', menu_order: 0, meta: {} } as unknown as WpPostResponse;
    expect(() => buildPrintRecord(malformed)).not.toThrow();
    expect(buildPrintRecord(malformed).title).toBe('');
  });

  it('degrades missing content/excerpt/embedded to empty values', () => {
    const r = buildPrintRecord({
      id: 1,
      type: 'post',
      status: 'draft',
      title: { rendered: 'T' },
      menu_order: 0,
      meta: {},
    });
    expect(r.content).toBe('');
    expect(r.excerpt).toBe('');
    expect(r.featuredImageUrl).toBe('');
    expect(r.tax).toEqual({});
    expect(r.title).toBe('T'); // falls back to rendered when raw is absent
  });
});
