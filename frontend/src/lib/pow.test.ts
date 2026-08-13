import { describe, expect, it } from 'vitest';
import { leadingZeroBits, sha256, solvePow } from './pow';

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256', () => {
  it('matches FIPS 180-4 test vectors', () => {
    expect(hex(sha256(encoder.encode('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(encoder.encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      hex(sha256(encoder.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('handles messages crossing block boundaries', () => {
    // 64 bytes: exactly one block, then a full padding block.
    const a = new Uint8Array(64).fill(0x61);
    expect(hex(sha256(a))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });
});

describe('leadingZeroBits', () => {
  it('counts full and partial bytes', () => {
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x80]))).toBe(16);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
  });
});

describe('solvePow', () => {
  it('finds a nonce that meets the difficulty', async () => {
    const target = { id: 'a'.repeat(32), salt: 'b'.repeat(32), difficulty: 8 };
    const nonce = await solvePow(target);
    expect(nonce).toMatch(/^\d+$/);
    // Recompute with the standalone sha256 to cross-check the wire format.
    const hash = sha256(encoder.encode(`${target.id}:${target.salt}:${nonce}`));
    expect(leadingZeroBits(hash)).toBeGreaterThanOrEqual(8);
  });

  it('reports progress and resolves', async () => {
    const calls: number[] = [];
    const target = { id: 'c'.repeat(32), salt: 'd'.repeat(32), difficulty: 6 };
    const nonce = await solvePow(target, { onProgress: (n) => calls.push(n) });
    expect(nonce).toMatch(/^\d+$/);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBeGreaterThanOrEqual(calls[0]);
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const target = { id: 'e'.repeat(32), salt: 'f'.repeat(32), difficulty: 20 };
    const pending = solvePow(target, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid difficulties', async () => {
    await expect(solvePow({ id: 'x', salt: 'y', difficulty: 0 })).rejects.toThrow(
      /invalid difficulty/,
    );
    await expect(solvePow({ id: 'x', salt: 'y', difficulty: 64 })).rejects.toThrow(
      /invalid difficulty/,
    );
  });
});
