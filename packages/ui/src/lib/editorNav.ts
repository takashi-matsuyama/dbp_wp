// Pure, framework-free navigation helpers behind the EditView outline and editor↔preview
// sync-scroll. Kept here (not inside the Svelte component) so the parsing/scroll math is
// unit-testable and shared by both editor modes. The component owns the DOM side (reading the
// live selection, scrolling the textarea, driving the sandbox iframe); these functions only
// take strings/metrics and return plain data.

import type { EditorMode } from './editorOps';

export interface Heading {
  /** Heading depth, 1–6. */
  level: number;
  /** Display text: Markdown markers / HTML tags stripped, whitespace collapsed, trimmed. */
  text: string;
  /**
   * Character offset in the source where the heading starts (the `#` in Markdown, the `<` of the
   * `<hN>` tag in HTML). The caller places the caret here and scrolls the textarea to it.
   */
  offset: number;
}

/**
 * Extract the heading outline from the active buffer. Markdown uses ATX headings (`#`–`######`)
 * and ignores `#` inside fenced code blocks; HTML uses `<h1>`–`<h6>`. Returns headings in source
 * order (i.e. by ascending offset).
 */
export function extractHeadings(text: string, mode: EditorMode): Heading[] {
  return mode === 'markdown' ? extractMarkdownHeadings(text) : extractHtmlHeadings(text);
}

// ATX heading: up to 3 leading spaces, 1–6 `#`, then either end-of-line or whitespace + content,
// with an optional trailing closing sequence of `#`s (CommonMark). `### foo` → "foo";
// `### foo ###` → "foo"; `###foo` is NOT a heading (no space) and won't match; `###` → empty.
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+[ \t]*)?$/;
// A fenced code block opens on a line of 3+ backticks or tildes (up to 3 leading spaces); an info
// string may follow the opening run. The capture is the marker run.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
// A closing fence is the same char, at least as long, with no info string (only trailing spaces).
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function extractMarkdownHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let offset = 0;
  // The fence marker char/length we're currently inside, or null when outside a code block.
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const run = line.match(FENCE_CLOSE_RE)?.[1];
      if (run && run[0] === fence.char && run.length >= fence.len) {
        fence = null;
      }
    } else {
      const open = line.match(FENCE_OPEN_RE)?.[1];
      if (open) {
        fence = { char: open[0]!, len: open.length };
      } else {
        const hm = line.match(ATX_RE);
        const hashes = hm?.[1];
        if (hashes) {
          out.push({
            level: hashes.length,
            text: (hm?.[2] ?? '').trim(),
            offset: offset + (line.length - line.trimStart().length),
          });
        }
      }
    }
    offset += line.length + 1; // +1 for the '\n' that split removed
  }
  return out;
}

const HTML_HEADING_OPEN_RE = /<h([1-6])\b[^>]*>/gi;

/**
 * Extract `<h1>`–`<h6>` headings with a single forward pass: match each opening tag, then find its
 * matching close with a bounded `indexOf`. An unclosed opening tag is skipped (not paired), and the
 * cursor advances past each close, so even pathological input (many unterminated headings) stays
 * linear — unlike a lazy global regex, which backtracks to EOF per unmatched open.
 */
function extractHtmlHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  const lower = text.toLowerCase(); // close-tag search is case-insensitive
  let m: RegExpExecArray | null;
  HTML_HEADING_OPEN_RE.lastIndex = 0;
  while ((m = HTML_HEADING_OPEN_RE.exec(text)) !== null) {
    const level = Number(m[1] ?? '0');
    const contentStart = m.index + m[0].length;
    const closeTag = `</h${level}>`;
    const close = lower.indexOf(closeTag, contentStart);
    if (close === -1) {
      continue; // unmatched open: skip, keep scanning from after this tag
    }
    out.push({ level, text: stripHtml(text.slice(contentStart, close)), offset: m.index });
    HTML_HEADING_OPEN_RE.lastIndex = close + closeTag.length; // don't rescan the consumed heading
  }
  return out;
}

/** Code point → string, ignoring out-of-range values so a malformed entity can't throw. */
function fromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip inner tags, decode the common entities, and collapse whitespace for outline display. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    // Numeric character references (decimal and hex), e.g. &#8211; (–), &#x2019; (’). Bounded
    // digit counts keep this linear and out of range values decode to nothing.
    .replace(/&#(\d{1,7});/g, (_, d: string) => fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&') // last, so an encoded "&amp;lt;" doesn't become "<"
    .replace(/\s+/g, ' ')
    .trim();
}

/** A scrollable element's vertical metrics. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Map a source pane's scroll position onto a target pane proportionally, returning the target's
 * scrollTop. Drives the one-way editor→preview sync: the editor's fraction of scroll progress is
 * applied to the preview. Returns 0 when either pane has nothing to scroll (avoids dividing by a
 * non-positive range), and clamps the ratio to [0, 1] against browser overscroll.
 */
export function proportionalScrollTop(
  source: ScrollMetrics,
  target: Pick<ScrollMetrics, 'scrollHeight' | 'clientHeight'>,
): number {
  const srcMax = source.scrollHeight - source.clientHeight;
  const tgtMax = target.scrollHeight - target.clientHeight;
  if (srcMax <= 0 || tgtMax <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, source.scrollTop / srcMax));
  return ratio * tgtMax;
}
