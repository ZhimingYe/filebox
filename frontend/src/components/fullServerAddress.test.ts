import { describe, expect, it } from 'vitest';
import { fullServerAddress } from './fullServerAddress';
import type { RootInfo } from '../api/client';

const roots: RootInfo[] = [
  { name: 'home', path_display: '/home/user', enabled: true, pinned_folders: [] },
  { name: 'tmp', path_display: '/tmp/', enabled: true, pinned_folders: [] },
  { name: 'rootfs', path_display: '/', enabled: true, pinned_folders: [] },
];

describe('fullServerAddress', () => {
  it('joins the root path_display with the file path', () => {
    expect(fullServerAddress(roots, 'home', '/docs/a.md')).toBe('/home/user/docs/a.md');
  });

  it('strips trailing slashes from path_display', () => {
    expect(fullServerAddress(roots, 'tmp', '/reports/x.md')).toBe('/tmp/reports/x.md');
  });

  it('handles a root whose path_display is "/"', () => {
    expect(fullServerAddress(roots, 'rootfs', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('returns the root alone when path is the root itself', () => {
    expect(fullServerAddress(roots, 'home', '/')).toBe('/home/user');
  });

  it('falls back to root:path when the root is unknown', () => {
    expect(fullServerAddress(roots, 'gone', '/a.txt')).toBe('gone/a.txt');
  });

  it('falls back to root:path when roots are undefined', () => {
    expect(fullServerAddress(undefined, 'home', '/a.txt')).toBe('home/a.txt');
  });
});
