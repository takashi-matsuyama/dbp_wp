import { spawn } from 'node:child_process';

export interface BrowserCommand {
  command: string;
  args: string[];
}

/** Return the OS-specific command to open a URL in the default browser. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd builtin; the empty title argument avoids quoting pitfalls.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

/** Best-effort: open the URL in the default browser. Never throws. */
export function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // If the launcher is missing, the user can still open the URL manually.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Ignore: opening a browser is a convenience, not a requirement.
  }
}
