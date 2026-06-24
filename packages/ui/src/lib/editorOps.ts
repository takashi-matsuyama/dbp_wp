// Pure, framework-free text transforms behind the EditView toolbar. Keeping them here (not inside
// the Svelte component) makes the formatting logic unit-testable and lets the Markdown and HTML
// buffers share it. Each transform takes the current value + selection and returns the new value
// plus the selection to restore, so the caller only writes the value back and re-selects.
//
// Design: wrapping-only (no toggle-off). Detecting "is the selection already bold" is fragile
// across Markdown/HTML and partial selections; predictable wrapping is the higher-quality choice
// for a first pass. Markdown block ops snap to whole lines (the markers are line-level); HTML
// block ops wrap the selection. Neither leaves the markers selected, so typing can't clobber them.

export type EditorMode = 'markdown' | 'html';
export type InlineKind = 'bold' | 'italic' | 'code' | 'link';
export type BlockKind = 'heading' | 'list' | 'quote';

/** A textarea's value and current selection range. */
export interface TextSelection {
  value: string;
  start: number;
  end: number;
}

/** The transformed value and the selection the caller should restore. */
export interface EditResult {
  value: string;
  start: number;
  end: number;
}

/** Inserted when the user clicks a toolbar button with no selection. */
const PLACEHOLDER = 'text';
/** The URL token left selected after a link insert, so the user can type the address over it. */
const URL_PLACEHOLDER = 'https://';

const INLINE_MD: Record<Exclude<InlineKind, 'link'>, string> = {
  bold: '**',
  italic: '*',
  code: '`',
};

const INLINE_HTML: Record<Exclude<InlineKind, 'link'>, [string, string]> = {
  bold: ['<strong>', '</strong>'],
  italic: ['<em>', '</em>'],
  code: ['<code>', '</code>'],
};

function splice(value: string, start: number, end: number, inner: string): string {
  return value.slice(0, start) + inner + value.slice(end);
}

/**
 * Wrap the selection with an inline format (bold/italic/code) or build a link. With no selection
 * a placeholder is inserted and left selected. For `link`, the URL token is the one left selected
 * (so the user types the address); for the others the visible text stays selected.
 */
export function applyInline(sel: TextSelection, kind: InlineKind, mode: EditorMode): EditResult {
  const hadSelection = sel.end > sel.start;
  const selected = hadSelection ? sel.value.slice(sel.start, sel.end) : PLACEHOLDER;

  let inner: string;
  let selStartOffset: number;
  let selLen: number;

  if (kind === 'link') {
    if (mode === 'markdown') {
      inner = `[${selected}](${URL_PLACEHOLDER})`;
      selStartOffset = selected.length + 3; // past "[" + text + "]("
      selLen = URL_PLACEHOLDER.length;
    } else {
      inner = `<a href="${URL_PLACEHOLDER}">${selected}</a>`;
      selStartOffset = '<a href="'.length;
      selLen = URL_PLACEHOLDER.length;
    }
  } else if (mode === 'markdown') {
    const marker = INLINE_MD[kind];
    inner = `${marker}${selected}${marker}`;
    selStartOffset = marker.length;
    selLen = selected.length;
  } else {
    const [open, close] = INLINE_HTML[kind];
    inner = `${open}${selected}${close}`;
    selStartOffset = open.length;
    selLen = selected.length;
  }

  const value = splice(sel.value, sel.start, sel.end, inner);
  const start = sel.start + selStartOffset;
  return { value, start, end: start + selLen };
}

/**
 * Apply a block format to the selection.
 *
 * Markdown markers (`## `, `- `, `> `) are line-level, so the selection is snapped to whole lines
 * before prefixing every line it touches — a mid-line cursor must never yield `hello ## world`.
 * The caret is left at the end of the block (nothing selected) so typing can't clobber the markers.
 *
 * HTML wraps the selection in the matching element. With no selection a placeholder is inserted and
 * only the placeholder text is left selected (so typing replaces `text`, keeping the tags); with a
 * real selection the caret is left after the closing tag.
 */
export function applyBlock(sel: TextSelection, kind: BlockKind, mode: EditorMode): EditResult {
  if (mode === 'markdown') {
    const lineStart = sel.value.lastIndexOf('\n', sel.start - 1) + 1;
    let lineEnd = sel.value.indexOf('\n', sel.end);
    if (lineEnd === -1) lineEnd = sel.value.length;
    const prefix = kind === 'heading' ? '## ' : kind === 'list' ? '- ' : '> ';
    const inner = sel.value
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((line) => prefix + line)
      .join('\n');
    const value = splice(sel.value, lineStart, lineEnd, inner);
    const caret = lineStart + inner.length;
    return { value, start: caret, end: caret };
  }

  const hadSelection = sel.end > sel.start;
  const selected = hadSelection ? sel.value.slice(sel.start, sel.end) : PLACEHOLDER;
  let inner: string;
  if (kind === 'heading') {
    inner = `<h2>${selected}</h2>`;
  } else if (kind === 'list') {
    const items = selected
      .split('\n')
      .map((line) => `  <li>${line}</li>`)
      .join('\n');
    inner = `<ul>\n${items}\n</ul>`;
  } else {
    inner = `<blockquote>${selected}</blockquote>`;
  }
  const value = splice(sel.value, sel.start, sel.end, inner);
  if (!hadSelection) {
    const start = sel.start + inner.indexOf(PLACEHOLDER);
    return { value, start, end: start + PLACEHOLDER.length };
  }
  const caret = sel.start + inner.length;
  return { value, start: caret, end: caret };
}

export interface TextStats {
  chars: number;
  words: number;
}

/** Character count (raw length) and word count (runs of non-whitespace). */
export function textStats(text: string): TextStats {
  const words = text.trim() === '' ? 0 : (text.trim().match(/\S+/g)?.length ?? 0);
  return { chars: text.length, words };
}
