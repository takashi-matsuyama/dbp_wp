import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders headings, emphasis, and paragraphs', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders multi-line content (lists and fenced code blocks)', () => {
    const html = renderMarkdown('- one\n- two\n\n```\ncode\n```');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>');
  });

  it('enables GitHub-flavored Markdown (tables)', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
  });

  it('returns a string synchronously (never a Promise)', () => {
    const html = renderMarkdown('plain text');
    expect(typeof html).toBe('string');
    expect(html).toContain('plain text');
  });

  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('does not sanitize — passes raw HTML through (kses sanitizes at save; preview is sandboxed)', () => {
    const html = renderMarkdown('<div class="x">raw</div>');
    expect(html).toContain('<div class="x">raw</div>');
  });
});
