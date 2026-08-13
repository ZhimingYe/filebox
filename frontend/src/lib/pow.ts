// Pure-JS SHA-256 + proof-of-work solver for the login challenge.
//
// No external dependencies: the hot loop reuses scratch buffers so ~1M
// hashes (difficulty 20) complete without GC pressure, in sub-second time on
// desktop browsers. Work is sliced into chunks that yield to the event loop
// between batches, so the login form never freezes and progress stays
// visible ("never freeze silently").
//
// Wire format (must match crates/hub/src/pow.rs byte-for-byte):
//   sha256("{id}:{salt}:{nonce}") with at least `difficulty` leading zero
//   bits, nonce being a decimal string.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

interface ShaScratch {
  msg: Uint8Array;
  w: Uint32Array;
  h: Uint32Array;
  dv: DataView;
  out: Uint8Array;
}

function makeScratch(): ShaScratch {
  const msg = new Uint8Array(128);
  return {
    msg,
    w: new Uint32Array(64),
    h: new Uint32Array(8),
    dv: new DataView(msg.buffer),
    out: new Uint8Array(32),
  };
}

/** SHA-256 over the first `len` bytes of `input`, into the scratch output
 *  buffer (returned). Scratch buffers are reused across calls; `input` is
 *  normally `scratch.msg` itself, pre-filled by the caller. */
function sha256Into(input: Uint8Array, len: number, scratch: ShaScratch): Uint8Array {
  // Allow ~2^29-byte inputs (length field stays 32-bit); our messages are
  // ≤ 86 bytes. `msg` grows if ever needed (dv is then rebound).
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  if (scratch.msg.length < paddedLen) {
    scratch.msg = new Uint8Array(paddedLen);
    scratch.dv = new DataView(scratch.msg.buffer);
  }
  const msg = scratch.msg;
  if (input !== msg) {
    msg.set(input.subarray(0, len), 0);
  }
  msg.fill(0, len, paddedLen);
  msg[len] = 0x80;
  const bitLen = len * 8;
  scratch.dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  scratch.dv.setUint32(paddedLen - 4, bitLen >>> 0);
  return sha256Blocks(scratch, paddedLen);
}

/** Block compression + output extraction. Assumes `scratch.msg` already
 *  holds a fully padded message (input | 0x80 | zeros | 64-bit length). */
function sha256Blocks(scratch: ShaScratch, paddedLen: number): Uint8Array {
  const w = scratch.w;
  const h = scratch.h;
  h.set(H0);
  const msg = scratch.msg;
  for (let i = 0; i < paddedLen; i += 64) {
    // Direct byte reads beat DataView.getUint32 in the hot loop (no call
    // overhead per word).
    for (let j = 0; j < 16; j++) {
      const o = i + j * 4;
      w[j] = (msg[o] << 24) | (msg[o + 1] << 16) | (msg[o + 2] << 8) | msg[o + 3];
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = scratch.out;
  for (let i = 0; i < 8; i++) {
    const v = h[i];
    out[i * 4] = (v >>> 24) & 0xff;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

/** Convenience: SHA-256 of an arbitrary byte string (allocates). */
export function sha256(data: Uint8Array): Uint8Array {
  const scratch = makeScratch();
  const msg = new Uint8Array(data.length);
  msg.set(data);
  const result = sha256Into(msg, data.length, scratch);
  return result.slice();
}

/** Count of leading zero bits in a hash byte string. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < hash.length; i++) {
    const b = hash[i];
    if (b === 0) {
      bits += 8;
    } else {
      bits += Math.clz32(b) - 24;
      break;
    }
  }
  return bits;
}

/** One proof-of-work challenge issued by the hub. */
export interface PowTarget {
  id: string;
  salt: string;
  difficulty: number;
}

/** Hashes attempted per event-loop slice — long enough to amortize the
 *  yield, short enough that each slice stays well under a frame budget. */
const CHUNK = 16384;
/** Hard cap: `2^difficulty * 512` attempts. The expected count is
 *  `2^difficulty`; hitting the cap means something is broken, so fail
 *  loudly instead of looping forever ("never freeze silently"). */
const MAX_ATTEMPTS_MULT = 512;
/** Nonces are fixed-width, zero-padded decimal strings. A constant width
 *  keeps the hashed message length constant, so the padding block (0x80,
 *  zeros, 64-bit length) is laid out once and only the digit bytes change
 *  per attempt — no per-hash string allocation, encode, copy, or fill.
 *  16 digits covers every reachable attempt count (2^32 × 512 < 10^16). */
const NONCE_WIDTH = 16;

/** Find a decimal nonce such that `sha256("{id}:{salt}:{nonce}")` has at
 *  least `difficulty` leading zero bits. Yields to the event loop between
 *  chunks and reports attempt counts so the UI can show progress.
 *  Throws on abort (AbortError) or if the attempt cap is exceeded. The
 *  returned nonce is zero-padded to [`NONCE_WIDTH`] digits — it is exactly
 *  the string that was hashed, so the hub must verify it verbatim. */
export async function solvePow(
  target: PowTarget,
  opts: { onProgress?: (attempts: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const { id, salt } = target;
  const difficulty = target.difficulty;
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32) {
    throw new Error(`invalid difficulty: ${target.difficulty}`);
  }
  const prefix = new TextEncoder().encode(`${id}:${salt}:`);
  const messageLen = prefix.length + NONCE_WIDTH;
  const scratch = makeScratch();
  const paddedLen = Math.ceil((messageLen + 9) / 64) * 64;
  if (scratch.msg.length < paddedLen) {
    scratch.msg = new Uint8Array(paddedLen);
    scratch.dv = new DataView(scratch.msg.buffer);
  }
  const msg = scratch.msg;
  // Lay out the message skeleton once: prefix, 0x80 terminator, zero
  // padding, and the 64-bit bit length. Only the digit bytes change.
  msg.fill(0, 0, paddedLen);
  msg.set(prefix, 0);
  msg[messageLen] = 0x80;
  const bitLen = messageLen * 8;
  scratch.dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  scratch.dv.setUint32(paddedLen - 4, bitLen >>> 0);

  const maxAttempts = Math.pow(2, difficulty) * MAX_ATTEMPTS_MULT;
  let nonce = 0;
  let attempts = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    for (let i = 0; i < CHUNK; i++, nonce++) {
      let value = nonce;
      for (let d = NONCE_WIDTH - 1; d >= 0; d--) {
        msg[prefix.length + d] = 48 + (value % 10);
        value = Math.floor(value / 10);
      }
      const hash = sha256Blocks(scratch, paddedLen);
      attempts++;
      if (leadingZeroBits(hash) >= difficulty) {
        opts.onProgress?.(attempts);
        // Keep the abort contract: an abort that lands mid-chunk must still
        // reject rather than resolve with a now-unwanted nonce.
        if (opts.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return String.fromCharCode(...msg.subarray(prefix.length, messageLen));
      }
    }
    if (attempts >= maxAttempts) {
      throw new Error('pow_solve_failed');
    }
    opts.onProgress?.(attempts);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
