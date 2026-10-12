import { randomToken, hashToken } from '../auth/session';

/** 256 random bits. The raw value belongs only in a newly created link fragment. */
export function newInvitationToken(): string {
  return randomToken();
}
export function hashInvitationToken(token: string): Promise<string> {
  return hashToken(`toothtalk:admin-invitation:v1:${token}`);
}
/** Reject the incomplete upper bucket instead of biasing decimal code values. */
export function newVerificationCode(): string {
  const range = 100_000_000;
  const ceiling = Math.floor(2 ** 32 / range) * range;
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= ceiling);
  return (sample[0] % range).toString().padStart(8, '0');
}
