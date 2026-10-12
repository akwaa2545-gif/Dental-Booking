import { describe, expect, it } from 'vitest';
import * as module from '../../src/web/liff-sdk';

describe('minimal official LIFF SDK composition', () => {
  it('installs only the required authentication and close-window API surface, without analytics or messaging', () => {
    const sdk = module.default;
    for (const method of ['init', 'login', 'logout', 'isLoggedIn', 'isInClient', 'getIDToken', 'closeWindow']) expect(sdk?.[method as keyof typeof sdk]).toBeTypeOf('function');
    expect(sdk).not.toHaveProperty('analytics'); expect(sdk).not.toHaveProperty('sendMessages'); expect(sdk).not.toHaveProperty('getProfile');
  });
});
