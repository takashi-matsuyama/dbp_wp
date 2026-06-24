import { describe, it, expect } from 'vitest';
import { applyInline, applyBlock, textStats, type TextSelection } from './editorOps';

function sel(value: string, start: number, end: number): TextSelection {
  return { value, start, end };
}

describe('applyInline', () => {
  it('wraps a Markdown selection in bold markers and keeps the text selected', () => {
    const r = applyInline(sel('a bold b', 2, 6), 'bold', 'markdown');
    expect(r.value).toBe('a **bold** b');
    expect(r.value.slice(r.start, r.end)).toBe('bold');
  });

  it('wraps an HTML selection in <em> and keeps the text selected', () => {
    const r = applyInline(sel('a x b', 2, 3), 'italic', 'html');
    expect(r.value).toBe('a <em>x</em> b');
    expect(r.value.slice(r.start, r.end)).toBe('x');
  });

  it('inserts a placeholder when there is no selection', () => {
    const r = applyInline(sel('', 0, 0), 'code', 'markdown');
    expect(r.value).toBe('`text`');
    expect(r.value.slice(r.start, r.end)).toBe('text');
  });

  it('builds a Markdown link with the URL token left selected', () => {
    const r = applyInline(sel('see here', 4, 8), 'link', 'markdown');
    expect(r.value).toBe('see [here](https://)');
    expect(r.value.slice(r.start, r.end)).toBe('https://');
  });

  it('builds an HTML link with the URL token left selected', () => {
    const r = applyInline(sel('here', 0, 4), 'link', 'html');
    expect(r.value).toBe('<a href="https://">here</a>');
    expect(r.value.slice(r.start, r.end)).toBe('https://');
  });
});

describe('applyBlock (Markdown — line-aware)', () => {
  it('prefixes each selected line and collapses the caret to the block end', () => {
    const r = applyBlock(sel('one\ntwo', 0, 7), 'list', 'markdown');
    expect(r.value).toBe('- one\n- two');
    expect(r.start).toBe(r.end); // caret collapsed, not selecting the markers
    expect(r.start).toBe(r.value.length);
  });

  it('snaps a mid-line selection to whole lines (no "hello ## world")', () => {
    const r = applyBlock(sel('hello world', 6, 11), 'heading', 'markdown');
    expect(r.value).toBe('## hello world');
  });

  it('snaps a collapsed mid-line cursor to the whole line (no "hello- text")', () => {
    const r = applyBlock(sel('hello', 5, 5), 'list', 'markdown');
    expect(r.value).toBe('- hello');
  });

  it('prefixes an empty line without inserting a placeholder', () => {
    const r = applyBlock(sel('', 0, 0), 'quote', 'markdown');
    expect(r.value).toBe('> ');
    expect(r.start).toBe(r.end);
    expect(r.start).toBe(2);
  });

  it('only snaps the lines the selection touches', () => {
    const r = applyBlock(sel('a\nb\nc', 2, 3), 'heading', 'markdown'); // selection within line "b"
    expect(r.value).toBe('a\n## b\nc');
  });
});

describe('applyBlock (HTML — wrap)', () => {
  it('wraps a selected heading and leaves the caret after the close tag', () => {
    const r = applyBlock(sel('Title', 0, 5), 'heading', 'html');
    expect(r.value).toBe('<h2>Title</h2>');
    expect(r.start).toBe(r.end);
    expect(r.start).toBe(r.value.length);
  });

  it('wraps multi-line list items', () => {
    const r = applyBlock(sel('one\ntwo', 0, 7), 'list', 'html');
    expect(r.value).toBe('<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>');
  });

  it('wraps a blockquote', () => {
    const r = applyBlock(sel('quoted', 0, 6), 'quote', 'html');
    expect(r.value).toBe('<blockquote>quoted</blockquote>');
  });

  it('selects only the placeholder text when there is no selection', () => {
    const r = applyBlock(sel('', 0, 0), 'heading', 'html');
    expect(r.value).toBe('<h2>text</h2>');
    expect(r.value.slice(r.start, r.end)).toBe('text'); // typing replaces "text", keeps the tags
  });
});

describe('textStats', () => {
  it('counts characters and whitespace-separated words', () => {
    expect(textStats('hello world')).toEqual({ chars: 11, words: 2 });
  });

  it('treats blank or whitespace-only text as zero words', () => {
    expect(textStats('   ')).toEqual({ chars: 3, words: 0 });
    expect(textStats('')).toEqual({ chars: 0, words: 0 });
  });

  it('collapses runs of whitespace when counting words', () => {
    expect(textStats('a   b\n\nc')).toEqual({ chars: 8, words: 3 });
  });
});
