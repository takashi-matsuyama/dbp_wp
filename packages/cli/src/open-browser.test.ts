import { describe, expect, it } from 'vitest';
import { browserCommand } from './open-browser';

describe('browserCommand', () => {
  it('uses open on macOS', () => {
    expect(browserCommand('http://localhost:4317/', 'darwin')).toEqual({
      command: 'open',
      args: ['http://localhost:4317/'],
    });
  });

  it('uses cmd start on Windows', () => {
    expect(browserCommand('http://localhost:4317/', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://localhost:4317/'],
    });
  });

  it('uses xdg-open on other platforms', () => {
    expect(browserCommand('http://localhost:4317/', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://localhost:4317/'],
    });
  });
});
