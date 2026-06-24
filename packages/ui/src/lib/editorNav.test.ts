import { describe, it, expect } from 'vitest';
import { extractHeadings, proportionalScrollTop } from './editorNav';

describe('extractHeadings (Markdown — ATX)', () => {
  it('extracts levels, text, and source offsets in order', () => {
    const text = '# Title\n\nintro\n\n## Section\ntext\n### Sub';
    const hs = extractHeadings(text, 'markdown');
    expect(hs).toEqual([
      { level: 1, text: 'Title', offset: 0 },
      { level: 2, text: 'Section', offset: text.indexOf('## Section') },
      { level: 3, text: 'Sub', offset: text.indexOf('### Sub') },
    ]);
  });

  it('strips a trailing closing sequence of hashes', () => {
    const hs = extractHeadings('## Heading ##', 'markdown');
    expect(hs).toEqual([{ level: 2, text: 'Heading', offset: 0 }]);
  });

  it('ignores text with no space after the hashes (not a heading)', () => {
    expect(extractHeadings('###notaheading', 'markdown')).toEqual([]);
  });

  it('keeps internal hashes in the heading text', () => {
    expect(extractHeadings('## a # b', 'markdown')).toEqual([{ level: 2, text: 'a # b', offset: 0 }]);
  });

  it('allows up to three leading spaces and records the offset at the hash', () => {
    const text = 'x\n   ## Indented';
    const hs = extractHeadings(text, 'markdown');
    expect(hs).toEqual([{ level: 2, text: 'Indented', offset: text.indexOf('##') }]);
  });

  it('ignores # inside a fenced code block (backticks)', () => {
    const text = '# Real\n\n```\n# not a heading\n## also not\n```\n\n## After';
    const hs = extractHeadings(text, 'markdown');
    expect(hs.map((h) => h.text)).toEqual(['Real', 'After']);
  });

  it('ignores # inside a tilde-fenced block and respects fence char/length', () => {
    // A shorter backtick run inside a tilde fence does not close it.
    const text = '~~~~\n# nope\n```\n# still nope\n~~~~\n## Out';
    const hs = extractHeadings(text, 'markdown');
    expect(hs.map((h) => h.text)).toEqual(['Out']);
  });

  it('treats an opening fence with an info string as a fence', () => {
    const text = '```js\n# code comment\n```\n# Heading';
    expect(extractHeadings(text, 'markdown').map((h) => h.text)).toEqual(['Heading']);
  });

  it('reads a bare hashes line as an empty heading', () => {
    expect(extractHeadings('###', 'markdown')).toEqual([{ level: 3, text: '', offset: 0 }]);
  });
});

describe('extractHeadings (HTML)', () => {
  it('extracts levels, tag-stripped text, and offsets', () => {
    const text = '<h1>Top</h1>\n<p>x</p>\n<h2 id="s">Section</h2>';
    const hs = extractHeadings(text, 'html');
    expect(hs).toEqual([
      { level: 1, text: 'Top', offset: 0 },
      { level: 2, text: 'Section', offset: text.indexOf('<h2') },
    ]);
  });

  it('strips inner tags and decodes common entities', () => {
    const hs = extractHeadings('<h3>a <em>b</em> &amp; c &lt;d&gt;</h3>', 'html');
    expect(hs).toEqual([{ level: 3, text: 'a b & c <d>', offset: 0 }]);
  });

  it('collapses whitespace across lines', () => {
    const hs = extractHeadings('<h2>\n  Multi\n  line\n</h2>', 'html');
    expect(hs).toEqual([{ level: 2, text: 'Multi line', offset: 0 }]);
  });

  it('is case-insensitive and matches the same level on close', () => {
    expect(extractHeadings('<H2>X</H2>', 'html')).toEqual([{ level: 2, text: 'X', offset: 0 }]);
    // A mismatched closing level does not pair.
    expect(extractHeadings('<h2>X</h3>', 'html')).toEqual([]);
  });

  it('skips an unclosed heading and still finds a later well-formed one', () => {
    const hs = extractHeadings('<h1>Open forever<h2>Real</h2>', 'html');
    expect(hs).toEqual([{ level: 2, text: 'Real', offset: '<h1>Open forever'.length }]);
  });

  it('decodes decimal and hex numeric character references', () => {
    expect(extractHeadings('<h2>en &#8211; dash &#x2019;</h2>', 'html')).toEqual([
      { level: 2, text: 'en – dash ’', offset: 0 },
    ]);
  });
});

describe('proportionalScrollTop', () => {
  it('maps the source fraction onto the target range', () => {
    const top = proportionalScrollTop(
      { scrollTop: 50, scrollHeight: 200, clientHeight: 100 }, // 50% scrolled (50 / 100)
      { scrollHeight: 600, clientHeight: 200 }, // range 400
    );
    expect(top).toBe(200); // 0.5 * 400
  });

  it('returns 0 when the source cannot scroll', () => {
    expect(
      proportionalScrollTop(
        { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
        { scrollHeight: 600, clientHeight: 200 },
      ),
    ).toBe(0);
  });

  it('returns 0 when the target cannot scroll', () => {
    expect(
      proportionalScrollTop(
        { scrollTop: 50, scrollHeight: 200, clientHeight: 100 },
        { scrollHeight: 100, clientHeight: 100 },
      ),
    ).toBe(0);
  });

  it('clamps overscroll to the target maximum', () => {
    const top = proportionalScrollTop(
      { scrollTop: 999, scrollHeight: 200, clientHeight: 100 },
      { scrollHeight: 600, clientHeight: 200 },
    );
    expect(top).toBe(400); // clamped to range, not overshoot
  });
});
