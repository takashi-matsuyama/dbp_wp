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
export type BlockKind = 'heading' | 'list' | 'orderedList' | 'quote';

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

/** Clamp a heading level to the valid HTML/Markdown range (h1–h6); a non-finite level falls to 2. */
function clampHeadingLevel(level: number): number {
  if (!Number.isFinite(level)) return 2;
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

/**
 * Apply a block format to the selection. `level` only applies to `heading` (the heading depth,
 * default 2; the title is usually h1, so the body starts at h2).
 *
 * Markdown markers (`## `, `- `, `1. `, `> `) are line-level, so the selection is snapped to whole
 * lines before prefixing every line it touches — a mid-line cursor must never yield `hello ## world`.
 * An ordered list numbers each touched line (`1.`, `2.`, …). The caret is left at the end of the
 * block (nothing selected) so typing can't clobber the markers.
 *
 * HTML wraps the selection in the matching element. With no selection a placeholder is inserted and
 * only the placeholder text is left selected (so typing replaces `text`, keeping the tags); with a
 * real selection the caret is left after the closing tag.
 */
export function applyBlock(
  sel: TextSelection,
  kind: BlockKind,
  mode: EditorMode,
  level = 2,
): EditResult {
  if (mode === 'markdown') {
    const lineStart = sel.value.lastIndexOf('\n', sel.start - 1) + 1;
    let lineEnd = sel.value.indexOf('\n', sel.end);
    if (lineEnd === -1) lineEnd = sel.value.length;
    const lines = sel.value.slice(lineStart, lineEnd).split('\n');
    const inner =
      kind === 'orderedList'
        ? lines.map((line, i) => `${i + 1}. ${line}`).join('\n')
        : lines
            .map((line) => {
              const prefix =
                kind === 'heading'
                  ? '#'.repeat(clampHeadingLevel(level)) + ' '
                  : kind === 'list'
                    ? '- '
                    : '> ';
              return prefix + line;
            })
            .join('\n');
    const value = splice(sel.value, lineStart, lineEnd, inner);
    const caret = lineStart + inner.length;
    return { value, start: caret, end: caret };
  }

  const hadSelection = sel.end > sel.start;
  const selected = hadSelection ? sel.value.slice(sel.start, sel.end) : PLACEHOLDER;
  let inner: string;
  if (kind === 'heading') {
    const lv = clampHeadingLevel(level);
    inner = `<h${lv}>${selected}</h${lv}>`;
  } else if (kind === 'list' || kind === 'orderedList') {
    const tag = kind === 'orderedList' ? 'ol' : 'ul';
    const items = selected
      .split('\n')
      .map((line) => `  <li>${line}</li>`)
      .join('\n');
    inner = `<${tag}>\n${items}\n</${tag}>`;
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

/**
 * Continue a Markdown list/quote on Enter, the way every Markdown editor does. Looks at the line
 * holding `caret` (selection must be collapsed); if it begins with a list marker (`-`/`*`/`+`),
 * an ordered marker (`N.`), or a blockquote (`>`):
 *
 * - a non-empty item inserts a newline + the same indented marker (ordered markers increment), so
 *   the next line stays in the list — splitting the item if the caret is mid-line;
 * - an empty item (just the marker) clears the marker line instead, exiting the list.
 *
 * Returns the new value + caret, or null when there is no list context (the caller leaves Enter to
 * its default). Markdown-only: HTML mode edits `<li>` tags directly, where line markers don't apply.
 */
export function continueBlock(value: string, caret: number): EditResult | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = value.indexOf('\n', caret);
  if (lineEnd === -1) lineEnd = value.length;
  // Drop a trailing CR so a CRLF line still matches (textareas use LF, but keep the contract robust).
  const line = value.slice(lineStart, lineEnd).replace(/\r$/, '');
  const m = /^(\s*)(-|\*|\+|>|(\d+)\.)(\s+)(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1] ?? '';
  const marker = m[2] ?? '';
  const orderedNum = m[3]; // undefined for an unordered/quote marker
  const space = m[4] ?? ' ';
  const content = m[5] ?? '';

  // Only continue when the caret is in (or after) the item content. A caret inside the indent or
  // marker means the user is editing the prefix — Enter there should split the line normally, not
  // duplicate the marker (e.g. Enter at the line start must not yield "\n- - one").
  const prefixLen = indent.length + marker.length + space.length;
  if (caret - lineStart < prefixLen) return null;

  // Empty item: exit the list by clearing the marker line, leaving a blank line with the caret.
  if (content.trim() === '') {
    const newValue = value.slice(0, lineStart) + value.slice(lineEnd);
    return { value: newValue, start: lineStart, end: lineStart };
  }

  // Non-empty item: continue with a fresh marker on the next line (ordered markers increment, but
  // an out-of-safe-range number is kept rather than rendered in exponential form).
  let nextMarker: string;
  if (orderedNum !== undefined) {
    const n = Number.parseInt(orderedNum, 10);
    // Keep the original digit string when +1 would overflow Number (avoids "1e+24." markers).
    nextMarker = Number.isSafeInteger(n + 1) ? `${n + 1}.${space}` : `${orderedNum}.${space}`;
  } else {
    nextMarker = `${marker}${space}`;
  }
  const insert = `\n${indent}${nextMarker}`;
  const newValue = value.slice(0, caret) + insert + value.slice(caret);
  const pos = caret + insert.length;
  return { value: newValue, start: pos, end: pos };
}

/** Escape a string for safe use inside an HTML double-quoted attribute value. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape alt text for Markdown image syntax: a `]` would close `![…]` early and a backslash could
 * escape the following character, so both are escaped; newlines are collapsed to spaces so the
 * `![…]()` stays on one line. (Alt is often seeded from a media title, which can contain these.)
 */
function escapeMarkdownAlt(alt: string): string {
  return alt
    .replace(/\\/g, '\\\\')
    .replace(/]/g, '\\]')
    .replace(/\s*\n\s*/g, ' ');
}

export interface ImageInsert {
  /** Image URL (a WordPress-generated media size URL). */
  url: string;
  /** Alt text. The picker requires it (accessibility); the transform trusts the caller. */
  alt: string;
}

/**
 * Insert an image at the cursor, replacing any selection: `![alt](url)` in Markdown, a self-closing
 * `<img>` with HTML-escaped attributes in HTML. The caret is left after the inserted markup. (URLs
 * come from the media library so are well-formed; HTML attributes are still escaped defensively.)
 */
export function insertImage(sel: TextSelection, image: ImageInsert, mode: EditorMode): EditResult {
  const inner =
    mode === 'markdown'
      ? `![${escapeMarkdownAlt(image.alt)}](${image.url})`
      : `<img src="${escapeAttr(image.url)}" alt="${escapeAttr(image.alt)}">`;
  const value = splice(sel.value, sel.start, sel.end, inner);
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
