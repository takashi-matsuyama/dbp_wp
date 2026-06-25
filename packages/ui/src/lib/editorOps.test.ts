import { describe, it, expect } from 'vitest';
import {
  applyInline,
  applyBlock,
  continueBlock,
  insertImage,
  textStats,
  type TextSelection,
} from './editorOps';

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

  it('uses the requested heading level (### for level 3)', () => {
    const r = applyBlock(sel('Sub', 0, 3), 'heading', 'markdown', 3);
    expect(r.value).toBe('### Sub');
  });

  it('numbers an ordered list across the selected lines', () => {
    const r = applyBlock(sel('one\ntwo\nthree', 0, 13), 'orderedList', 'markdown');
    expect(r.value).toBe('1. one\n2. two\n3. three');
  });

  it('clamps an out-of-range heading level into h1–h6', () => {
    expect(applyBlock(sel('x', 0, 1), 'heading', 'markdown', 9).value).toBe('###### x');
    expect(applyBlock(sel('x', 0, 1), 'heading', 'markdown', 0).value).toBe('# x');
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

  it('wraps a heading at the requested level', () => {
    expect(applyBlock(sel('Sub', 0, 3), 'heading', 'html', 3).value).toBe('<h3>Sub</h3>');
  });

  it('wraps an ordered list in <ol>', () => {
    const r = applyBlock(sel('one\ntwo', 0, 7), 'orderedList', 'html');
    expect(r.value).toBe('<ol>\n  <li>one</li>\n  <li>two</li>\n</ol>');
  });
});

describe('continueBlock (Markdown Enter)', () => {
  // Caret offsets are at the end of the first line unless noted.
  it('continues an unordered list with the same marker', () => {
    const r = continueBlock('- one', 5);
    expect(r).not.toBeNull();
    expect(r?.value).toBe('- one\n- ');
    expect(r?.start).toBe(r?.value.length);
  });

  it('increments an ordered list marker', () => {
    const r = continueBlock('1. one', 6);
    expect(r?.value).toBe('1. one\n2. ');
  });

  it('continues a blockquote', () => {
    const r = continueBlock('> quoted', 8);
    expect(r?.value).toBe('> quoted\n> ');
  });

  it('preserves indentation (nested list)', () => {
    const r = continueBlock('  - item', 8);
    expect(r?.value).toBe('  - item\n  - ');
  });

  it('exits the list when the item is empty (clears the marker line)', () => {
    const r = continueBlock('- one\n- ', 8); // caret on the empty second marker
    expect(r?.value).toBe('- one\n');
    expect(r?.start).toBe(6); // caret at the (now blank) line start
  });

  it('splits the item when Enter is pressed mid-line', () => {
    const r = continueBlock('- onetwo', 5); // caret between "one" and "two"
    expect(r?.value).toBe('- one\n- two');
  });

  it('returns null when the line has no list marker', () => {
    expect(continueBlock('plain text', 5)).toBeNull();
    expect(continueBlock('', 0)).toBeNull();
  });

  it('returns null when the caret is inside the indent or marker (Enter just splits the line)', () => {
    expect(continueBlock('- one', 0)).toBeNull(); // caret at the very start
    expect(continueBlock('- one', 1)).toBeNull(); // caret between marker and space
    expect(continueBlock('1. one', 2)).toBeNull(); // caret inside the ordered marker
  });

  it('matches a CRLF line (trailing CR is ignored)', () => {
    const r = continueBlock('1. one\r\n2. two', 6); // caret at end of the first line, before CRLF
    expect(r).not.toBeNull();
    expect(r?.value.startsWith('1. one\n2. ')).toBe(true);
  });

  it('keeps the original number string when incrementing would overflow Number', () => {
    const big = '999999999999999999999999';
    const r = continueBlock(`${big}. x`, `${big}. x`.length);
    expect(r?.value).toBe(`${big}. x\n${big}. `); // no "1e+24." marker
  });
});

describe('insertImage', () => {
  it('inserts Markdown image syntax at the cursor with the caret after it', () => {
    const r = insertImage(sel('a b', 2, 2), { url: 'https://x/y.png', alt: 'Y' }, 'markdown');
    expect(r.value).toBe('a ![Y](https://x/y.png)b');
    expect(r.start).toBe(r.end);
    expect(r.value.slice(0, r.start)).toBe('a ![Y](https://x/y.png)');
  });

  it('inserts a self-closing HTML img, replacing any selection', () => {
    const r = insertImage(sel('[x]', 0, 3), { url: 'https://x/y.png', alt: 'Y' }, 'html');
    expect(r.value).toBe('<img src="https://x/y.png" alt="Y">');
  });

  it('escapes Markdown alt delimiters and collapses newlines', () => {
    const r = insertImage(sel('', 0, 0), { url: 'https://x/y.png', alt: 'a]b\\c\nd' }, 'markdown');
    expect(r.value).toBe('![a\\]b\\\\c d](https://x/y.png)');
  });

  it('escapes HTML attributes to prevent breaking out of the tag', () => {
    const r = insertImage(
      sel('', 0, 0),
      { url: 'https://x/y.png?a=1&b=2', alt: 'a "quote" <b>' },
      'html',
    );
    expect(r.value).toBe(
      '<img src="https://x/y.png?a=1&amp;b=2" alt="a &quot;quote&quot; &lt;b&gt;">',
    );
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
