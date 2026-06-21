import { marked } from 'marked';

/**
 * Convert Markdown source to HTML for the single-post body editor.
 *
 * One shared implementation, used by the UI (live preview and the HTML mirrored into
 * `post_content` on save) and available to the CLI/future MCP layer, so a post's stored
 * HTML always matches what the editor previewed. GitHub-flavored Markdown is enabled.
 *
 * This does NOT sanitize the output. Sanitization is delegated to WordPress `kses` at save
 * time (capability-dependent), and the live preview is isolated in a sandboxed iframe with
 * no script execution — matching the body-editing design (no extra sanitizer dependency in
 * DBP WP).
 */
export function renderMarkdown(markdown: string): string {
  // `async: false` selects marked's synchronous overload (string return). Guard the result
  // so an unexpected non-string (e.g. a future async extension) degrades to empty rather
  // than leaking a Promise into the rendered body.
  const html = marked.parse(markdown, { async: false, gfm: true });
  return typeof html === 'string' ? html : '';
}
