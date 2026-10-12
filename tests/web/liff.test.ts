import { describe, expect, it, vi } from 'vitest';
import * as liffModule from '../../src/web/liff';

const now = () => new Date('2026-10-08T00:00:00Z');
const session = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic-csrf', expiresAt: '2026-10-08T02:00:00Z', isAdmin: false };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function sdk(overrides = {}) {
  return { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => true, isInClient: () => false, login: vi.fn(), getIDToken: () => 'synthetic.raw.id-token', logout: vi.fn(), closeWindow: vi.fn(), ...overrides };
}
function setup(overrides = {}) {
  const line = sdk();
  const fetcher = vi.fn().mockImplementation(async () => response(session));
  const loadSdk = vi.fn().mockResolvedValue(line);
  return { line, fetcher, loadSdk, options: { liffId: '1234567890-Example', staging: true, origin: 'https://staging.example', now, fetch: fetcher, loadSdk, ...overrides } };
}

describe('LIFF same-origin bootstrap', () => {
  it('exports a real bootstrap factory', () => { expect(liffModule.createLiffBootstrap).toBeTypeOf('function'); });
  it('checks same-origin backend readiness before SDK init, then sends only raw ID token to establish the session', async () => {
    const { options, line, fetcher } = setup();
    const result = await liffModule.createLiffBootstrap(options)();
    expect(line.init).toHaveBeenCalledWith({ liffId: options.liffId });
    expect(result).toEqual({ session, sdk: line, tokenFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(['/api/session', expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })]);
    expect(fetcher.mock.calls[1]).toEqual(['/api/auth/liff', expect.objectContaining({ method: 'POST', body: JSON.stringify({ idToken: 'synthetic.raw.id-token' }), credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })]);
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('Content-Type')).toBe('application/json');
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('shares the bootstrap promise across StrictMode effect replays without replaying the session-establishing write', async () => {
    const { options, line, fetcher } = setup(); const bootstrap = liffModule.createLiffBootstrap(options);
    await Promise.all([bootstrap(), bootstrap()]); expect(line.init).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('waits for LIFF initialization before reading a token or navigating', async () => {
    let ready!: () => void; const init = new Promise<void>(resolve => { ready = resolve; });
    const getIDToken = vi.fn().mockReturnValue('synthetic.raw.id-token');
    const line = sdk({ init: vi.fn().mockReturnValue(init), getIDToken });
    const { options, fetcher } = setup({ loadSdk: async () => line }); const pending = liffModule.createLiffBootstrap(options)();
    await vi.waitFor(() => expect(line.init).toHaveBeenCalled()); expect(getIDToken).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe('/api/session');
    ready(); await pending; expect(getIDToken).toHaveBeenCalledOnce();
  });
  it('uses LIFF login with a clean same-origin root only for an unauthenticated external browser', async () => {
    const line = sdk({ isLoggedIn: () => false }); const { options, fetcher } = setup({ loadSdk: async () => line });
    expect(await liffModule.createLiffBootstrap(options)()).toBeNull();
    expect(line.login).toHaveBeenCalledWith({ redirectUri: 'https://staging.example/' }); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe('/api/session');
  });
  it('does not invoke unsupported external login inside the LIFF browser', async () => {
    const line = sdk({ isLoggedIn: () => false, isInClient: () => true }); const { options, fetcher } = setup({ loadSdk: async () => line });
    await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(line.login).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe('/api/session');
  });
  it.each([{ liffId: '' }, { staging: false }, { origin: 'http://staging.example' }, { origin: 'https://staging.example/path' }])('fails closed before SDK or auth requests on invalid configuration %j', async override => {
    const { options, fetcher, loadSdk } = setup(override); await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(fetcher).not.toHaveBeenCalled(); expect(loadSdk).not.toHaveBeenCalled();
  });
  it('never posts a missing ID token', async () => {
    const { options, fetcher } = setup({ loadSdk: async () => sdk({ getIDToken: () => null }) }); await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe('/api/session');
  });
  it.each([{ ...session, accountId: 'forged' }, { ...session, csrfToken: '' }, { ...session, isAdmin: 'true' }, { ...session, expiresAt: '2026-10-07T00:00:00Z' }])('refuses malformed or expired server sessions %j', async malformed => {
    const { options } = setup({ fetch: vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(malformed)) }); await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('sanitizes SDK failures and never exposes raw tokens or provider errors', async () => {
    const { options } = setup({ loadSdk: async () => { throw new Error('PRIVATE_CANARY'); } }); await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
  });
  it('preserves a controlled auth failure and never retries it automatically', async () => {
    const { options, fetcher } = setup(); fetcher.mockImplementation(async () => response({ error: { code: 'UNAUTHENTICATED' } }, 401)); const bootstrap = liffModule.createLiffBootstrap(options);
    await expect(bootstrap()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); await expect(bootstrap()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});


describe('fail-closed backend readiness gate', () => {
  it('waits for the backend response before even loading the SDK module', async () => {
    let finish!: (result: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; })).mockImplementation(async () => response(session));
    const { options, loadSdk } = setup({ fetch: fetcher }); const pending = liffModule.createLiffBootstrap(options)();
    await Promise.resolve(); expect(loadSdk).not.toHaveBeenCalled();
    finish(response({ error: { code: 'UNAUTHENTICATED' } }, 401)); await pending; expect(loadSdk).toHaveBeenCalledOnce();
  });
  it.each([
    [503, { error: { code: 'UNAVAILABLE' } }], [500, { error: { code: 'UNAUTHENTICATED' } }],
    [401, { error: { code: 'FORBIDDEN' } }], [401, {}], [200, {}], [403, { error: { code: 'FORBIDDEN' } }],
    [200, { ...session, expiresAt: '2026-10-07T00:00:00Z' }], [201, session],
  ])('blocks SDK loading and token exchange for unready or malformed response %s %j', async (status, body) => {
    const fetcher = vi.fn().mockImplementation(async () => response(body, status as number));
    const { options, loadSdk, line } = setup({ fetch: fetcher });
    await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAVAILABLE', phase: 'setup' });
    expect(loadSdk).not.toHaveBeenCalled(); expect(line.init).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/session');
  });
  it.each(['transport', 'html'])('sanitizes %s preflight failure without SDK or provider calls', async failure => {
    const fetcher = vi.fn().mockImplementation(async () => { if (failure === 'transport') throw new Error('PRIVATE_NETWORK_CANARY'); return new Response('<html>PRIVATE_CANARY</html>', { status: 503 }); });
    const { options, loadSdk } = setup({ fetch: fetcher });
    await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ code: 'UNAVAILABLE', phase: 'setup', message: 'UNAVAILABLE' }); expect(loadSdk).not.toHaveBeenCalled();
  });
});

describe('bounded backend readiness', () => {
  it('supplies a ten-second timeout and fails closed without provider requests when it fires', async () => {
    const controller = new AbortController(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const fetcher = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); }));
      const { options, loadSdk } = setup({ fetch: fetcher }); const pending = liffModule.createLiffBootstrap(options)();
      expect(timeout).toHaveBeenCalledWith(10000); expect(loadSdk).not.toHaveBeenCalled();
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE', phase: 'setup' }); expect(loadSdk).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });
});

describe('opaque authentication diagnostics', () => {
  it.each([
    ['load', 'A01'], ['init', 'A02'], ['token', 'A03'], ['fingerprint', 'A04'], ['transport', 'A05'], ['response', 'A06'], ['session', 'A07'],
  ])('distinguishes %s failures without raw errors or invented HTTP status', async (stage, diagnostic) => {
    const privateError = new Error('PRIVATE_CANARY https://private.example/?token=SECRET');
    const line = sdk();
    if (stage === 'init') line.init.mockRejectedValue(privateError);
    if (stage === 'token') line.getIDToken = () => { throw privateError; };
    const digest = stage === 'fingerprint' ? vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(privateError) : undefined;
    const fetcher = vi.fn().mockResolvedValueOnce(response(session)).mockImplementation(async () => {
      if (stage === 'transport') throw privateError;
      if (stage === 'response') return new Response('PRIVATE_CANARY', { status: 502 });
      return response({ ...session, csrfToken: null });
    });
    try {
      const { options } = setup({ fetch: fetcher, loadSdk: async () => { if (stage === 'load') throw privateError; return line; } });
      const failure = await liffModule.createLiffBootstrap(options)().catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE', diagnostic });
      expect(failure).toHaveProperty('responseStatus', stage === 'response' ? 502 : stage === 'session' ? 200 : undefined);
      expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_CANARY|private\.example|SECRET|synthetic.raw/);
      expect(fetcher).toHaveBeenCalledTimes(['transport', 'response', 'session'].includes(stage) ? 2 : 1);
    } finally { digest?.mockRestore(); }
  });
  it.each(['A10', 'A11'])('accepts only the server auth 503 diagnostic %s', async diagnostic => {
    const { options } = setup({ fetch: vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ error: { code: 'UNAVAILABLE', diagnostic, message: 'PRIVATE_CANARY' } }, 503)) });
    await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ diagnostic: 'A06', serverDiagnostic: diagnostic, responseStatus: 503, code: 'UNAVAILABLE' });
  });
  it.each([
    [401, 'UNAUTHENTICATED', 'A10'], [500, 'UNAVAILABLE', 'A11'], [503, 'FORBIDDEN', 'A10'],
    [503, 'PRIVATE_CANARY', 'A10'], [503, 'UNAVAILABLE', 'A12'], [503, 'UNAVAILABLE', 'PRIVATE_CANARY'], [503, 'UNAVAILABLE', { toString: 'A10' }],
  ])('ignores an untrusted server diagnostic at %s / %s / %j', async (status, code, diagnostic) => {
    const { options } = setup({ fetch: vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ error: { code, diagnostic } }, status as number)) });
    const failure = await liffModule.createLiffBootstrap(options)().catch((error: unknown) => error);
    expect(failure).toMatchObject({ diagnostic: 'A06' }); expect(failure).toHaveProperty('serverDiagnostic', undefined);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_CANARY');
  });
  it('does not expose an unexpected HTTP status or server error code', async () => {
    const { options } = setup({ fetch: vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ error: { code: 'PRIVATE_CANARY', diagnostic: 'A10' } }, 599)) });
    await expect(liffModule.createLiffBootstrap(options)()).rejects.toMatchObject({ diagnostic: 'A06', code: 'UNAVAILABLE', responseStatus: undefined, serverDiagnostic: undefined });
  });
});


describe('rejected ID-token recovery capabilities', () => {
  async function rejected(line = sdk(), status = 401, code = 'UNAUTHENTICATED') {
    const { options, fetcher } = setup({ loadSdk: async () => line });
    fetcher.mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ error: { code, message: 'PRIVATE_BODY_CANARY' } }, status));
    const failure = await liffModule.createLiffBootstrap(options)().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(liffModule.LiffAuthError);
    return { failure: failure as liffModule.LiffAuthError, fetcher, line };
  }
  it('exposes only a safe one-shot action after an explicit rejected-token response', async () => {
    const { failure, fetcher, line } = await rejected();
    expect(failure.recovery?.kind).toBe('external-login');
    expect(line.logout).not.toHaveBeenCalled(); expect(line.login).not.toHaveBeenCalled();
    failure.recovery?.run?.(); failure.recovery?.run?.();
    expect(line.logout).toHaveBeenCalledOnce(); expect(line.login).toHaveBeenCalledExactlyOnceWith({ redirectUri: 'https://staging.example/' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(failure)).not.toMatch(/synthetic|PRIVATE_BODY_CANARY|staging.example/);
    expect(failure).not.toHaveProperty('sdk'); expect(failure).not.toHaveProperty('tokenFingerprint');
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('offers LIFF closing with no unsupported SDK logout or login', async () => {
    const { failure, fetcher, line } = await rejected(sdk({ isInClient: () => true }));
    expect(failure.recovery?.kind).toBe('reopen-liff');
    failure.recovery?.run?.(); failure.recovery?.run?.();
    expect(line.closeWindow).toHaveBeenCalledOnce(); expect(line.logout).not.toHaveBeenCalled(); expect(line.login).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[401, 'UNAVAILABLE'], [401, 'FORBIDDEN'], [403, 'UNAUTHENTICATED'], [503, 'UNAUTHENTICATED'], [503, 'UNAVAILABLE']])('does not offer rejected-token recovery for %s %s', async (status, code) => {
    const { failure, line } = await rejected(sdk(), status as number, code as string);
    expect(failure.recovery).toBeUndefined(); expect(line.logout).not.toHaveBeenCalled(); expect(line.login).not.toHaveBeenCalled(); expect(line.closeWindow).not.toHaveBeenCalled();
  });
  it('preserves rejected-token diagnostics and requires manual reopening if browser detection fails', async () => {
    const { failure, line } = await rejected(sdk({ isInClient: () => { throw new Error('PRIVATE_BROWSER_CANARY'); } }));
    expect(liffModule.authDiagnosticText(failure)).toBe('A06 · HTTP 401 · UNAUTHENTICATED');
    expect(failure.recovery).toMatchObject({ kind: 'reopen-liff' }); expect(failure.recovery?.run).toBeUndefined();
    expect(line.logout).not.toHaveBeenCalled(); expect(line.login).not.toHaveBeenCalled(); expect(line.closeWindow).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_BROWSER_CANARY');
  });
  it('sanitizes SDK action failures and makes the recovery capability one-shot even on failure', async () => {
    const { failure, line } = await rejected(sdk({ logout: vi.fn(() => { throw new Error('PRIVATE_RECOVERY_CANARY'); }) }));
    expect(() => failure.recovery?.run?.()).toThrow('UNAVAILABLE');
    expect(() => failure.recovery?.run?.()).not.toThrow();
    expect(line.logout).toHaveBeenCalledOnce(); expect(line.login).not.toHaveBeenCalled();
  });
});
