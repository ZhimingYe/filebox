import { describe, expect, it } from 'vitest';
import { parentDir } from './parentDir';

describe('parentDir', () => {
  it('returns the containing directory for a nested file', () => {
    expect(parentDir('/ongoing/20_WGCNA/image.png')).toBe('/ongoing/20_WGCNA');
  });

  it('returns root for a top-level file', () => {
    expect(parentDir('/readme.md')).toBe('/');
  });

  it('returns root for the root path itself', () => {
    expect(parentDir('/')).toBe('/');
  });

  it('strips trailing slashes before computing the parent', () => {
    expect(parentDir('/a/b/')).toBe('/a');
    expect(parentDir('/a/')).toBe('/');
  });

  it('handles deeper nesting', () => {
    expect(parentDir('/a/b/c/d.txt')).toBe('/a/b/c');
  });
});
