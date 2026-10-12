// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as tokens from '../../src/worker/admin-management/tokens';
function utilities() {
  expect(tokens).toHaveProperty('newInvitationToken', expect.any(Function));
  expect(tokens).toHaveProperty('hashInvitationToken', expect.any(Function));
  expect(tokens).toHaveProperty('newVerificationCode', expect.any(Function));
  return tokens;
}
describe('invitation cryptographic utilities', () => {
  it('uses exactly 32 random bytes for a 43-character URL-safe bearer token', () => {
    const { newInvitationToken } = utilities();
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      expect(array).toBeInstanceOf(Uint8Array); expect(array?.byteLength).toBe(32);
      (array as Uint8Array).fill(255); return array;
    });
    try { expect(newInvitationToken()).toBe('_'.repeat(42) + '8'); expect(spy).toHaveBeenCalledOnce(); } finally { spy.mockRestore(); }
  });
  it('domain-separates SHA-256 token hashes from session hashes', async () => {
    const { hashInvitationToken } = utilities(), token = 'a'.repeat(43);
    expect(await hashInvitationToken(token)).toBe(createHash('sha256').update('toothtalk:admin-invitation:v1:' + token).digest('hex'));
    expect(await hashInvitationToken(token)).not.toBe(createHash('sha256').update(token).digest('hex'));
  });
  it('samples uniform eight-digit decimal codes, rejecting biased 32-bit tails', () => {
    const { newVerificationCode } = utilities(); const values = [4294967295, 4200000000, 4199999999, 0, 1234];
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      expect(array).toBeInstanceOf(Uint32Array); (array as Uint32Array)[0] = values.shift()!; return array;
    });
    try { expect(newVerificationCode()).toBe('99999999'); expect(newVerificationCode()).toBe('00000000'); expect(newVerificationCode()).toBe('00001234'); expect(spy).toHaveBeenCalledTimes(5); } finally { spy.mockRestore(); }
  });
  it('creates independent tokens and codes without Math.random', () => {
    const { newInvitationToken, newVerificationCode } = utilities();
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw Error('Unsafe RNG'); });
    try { const generated = new Set(Array.from({ length: 20 }, newInvitationToken)); expect(generated.size).toBe(20); for (const token of generated) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(newVerificationCode()).toMatch(/^[0-9]{8}$/); } finally { spy.mockRestore(); }
  });
});
