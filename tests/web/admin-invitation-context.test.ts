import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureInvitationContext, clearInvitationContext, readInvitationContext } from '../../src/web/invitations/context';
import { createLiffBootstrap } from '../../src/web/liff';

const token = 'a'.repeat(43);
const now = () => new Date('2026-10-10T10:00:00Z');
const key = 'toothtalk.admin-invitation.v1';
const session = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic', isAdmin: false, expiresAt: '2026-10-10T12:00:00Z' };
const response = () => new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json' } });
function runtime(loggedIn = false) {
  const sdk = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => loggedIn, isInClient: () => false,
    login: vi.fn(), logout: vi.fn(), closeWindow: vi.fn(), getIDToken: () => 'synthetic-id-token' };
  const options = { liffId: '12345-abc', staging: true, origin: 'https://staging.example', now, fetch: vi.fn(async () => response()), loadSdk: async () => sdk };
  return { sdk, options };
}
beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('tab-local invitation context', () => {
  it('captures only the direct invitation fragment and strips it before normal navigation', () => {
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    captureInvitationContext(window.location, window.history, sessionStorage, now());
    expect(window.location.href).not.toContain(token); expect(window.location.hash).toBe('');
    expect(readInvitationContext(sessionStorage, now())).toEqual({ token, capturedAt: now().toISOString() });
    expect(Object.keys(JSON.parse(sessionStorage.getItem(key)!))).toEqual(['token', 'capturedAt']);
  });
  it.each(['short', `${token}&x=1`, `${token}%20`, 'x'.repeat(44)])('removes malformed own fragments without persisting %s', invalid => {
    window.history.replaceState(null, '', `/admin-invitation#invite=${invalid}`);
    captureInvitationContext(window.location, window.history, sessionStorage, now());
    expect(window.location.hash).toBe(''); expect(readInvitationContext(sessionStorage, now())).toBeNull();
  });
  it.each([`/#invite=${token}`, `/admin-invitation#access_token=${token}`, `/admin-invitation#anything=${token}`, `/admin-invitation?liff.state=primary#invite=${token}`])('does not interpret or mutate unrelated/provider URL %s', path => {
    window.history.replaceState(null, '', path); const original = window.location.href;
    captureInvitationContext(window.location, window.history, sessionStorage, now());
    expect(window.location.href).toBe(original); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('strips its direct fragment even when tab storage is denied', () => {
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    const denied = { setItem() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage;
    expect(() => captureInvitationContext(window.location, window.history, denied, now())).not.toThrow();
    expect(window.location.hash).toBe(''); expect(readInvitationContext(denied, now())).toBeNull();
    expect(() => clearInvitationContext(denied)).not.toThrow();
  });
  it('cannot fall back to an older stored bearer when replacement and clearing are denied', () => {
    const old = JSON.stringify({ token: 'b'.repeat(43), capturedAt: now().toISOString() });
    const partiallyDenied = { getItem() { return old; }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage;
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    captureInvitationContext(window.location, window.history, partiallyDenied, now());
    expect(window.location.hash).toBe(''); expect(readInvitationContext(partiallyDenied, now())).toBeNull();
  });
  it('keeps a denial fence when replacement and removal silently retain an older bearer', () => {
    const old = JSON.stringify({ token: 'b'.repeat(43), capturedAt: now().toISOString() });
    const denied = { getItem() { return old; }, setItem() {}, removeItem() {} } as unknown as Storage;
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    captureInvitationContext(window.location, window.history, denied, now());
    expect(window.location.hash).toBe(''); expect(readInvitationContext(denied, now())).toBeNull();
    clearInvitationContext(denied); expect(readInvitationContext(denied, now())).toBeNull();
  });
  it('lifts a denial fence only after storage removal or a new write is positively verified', () => {
    let value: string | null = JSON.stringify({ token: 'b'.repeat(43), capturedAt: now().toISOString() });
    let removalAllowed = false, writesAllowed = false;
    const storage = { getItem() { return value; }, setItem(_key: string, next: string) { if (writesAllowed) value = next; }, removeItem() { if (removalAllowed) value = null; } } as unknown as Storage;
    clearInvitationContext(storage); expect(readInvitationContext(storage, now())).toBeNull();
    writesAllowed = true; window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    captureInvitationContext(window.location, window.history, storage, now());
    expect(readInvitationContext(storage, now())?.token).toBe(token);
    removalAllowed = true; clearInvitationContext(storage); expect(value).toBeNull();
  });
  it.each([null, 'bad json', JSON.stringify({ token, capturedAt: 'invalid' }), JSON.stringify({ token, capturedAt: '2026-10-11T00:00:00Z' }), JSON.stringify({ token, capturedAt: '2026-10-09T10:00:00Z' }), JSON.stringify({ token, capturedAt: now().toISOString(), extra: true })])('clears malformed, future and exactly 24-hour-old storage %s', value => {
    if (value !== null) sessionStorage.setItem(key, value);
    expect(readInvitationContext(sessionStorage, now())).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('retains valid context until strictly before 24 hours and clears explicitly', () => {
    sessionStorage.setItem(key, JSON.stringify({ token, capturedAt: '2026-10-09T10:00:00.001Z' }));
    expect(readInvitationContext(sessionStorage, now())?.token).toBe(token);
    clearInvitationContext(sessionStorage); expect(sessionStorage.getItem(key)).toBeNull();
  });
});

describe('invitation LIFF boundary', () => {
  it('removes its direct secret before SDK loading/init and supplies a clean exact login return', async () => {
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    const { sdk, options } = runtime(); options.loadSdk = async () => { expect(window.location.hash).toBe(''); return sdk; };
    await createLiffBootstrap(options)();
    expect(sdk.login).toHaveBeenCalledExactlyOnceWith({ redirectUri: 'https://staging.example/admin-invitation' });
    expect(JSON.stringify(options.fetch.mock.calls)).not.toContain(token);
    expect(readInvitationContext(sessionStorage, now())?.token).toBe(token);
  });
  it('preserves primary provider credentials and liff parameters while init is pending', async () => {
    window.history.replaceState(null, '', '/admin-invitation?liff.state=synthetic&liff.referrer=LINE#access_token=provider-canary&token_type=Bearer');
    const original = window.location.href; const { sdk, options } = runtime(true);
    let finish!: () => void; sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = createLiffBootstrap(options)(); await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    expect(window.location.href).toBe(original); expect(sessionStorage.getItem(key)).toBeNull();
    finish(); await pending; expect(window.location.href).toBe(original);
  });
  it('fails closed on a combined provider redirect and own fragment, cleaning only after init resolves', async () => {
    window.history.replaceState(null, '', `/admin-invitation?liff.state=synthetic#invite=${token}`);
    const original = window.location.href; const { sdk, options } = runtime();
    let finish!: () => void; sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = createLiffBootstrap(options)(); await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    expect(window.location.href).toBe(original); expect(sessionStorage.getItem(key)).toBeNull();
    finish(); await pending;
    expect(window.location.hash).toBe(''); expect(window.location.search).toBe('?liff.state=synthetic');
    expect(sdk.login).toHaveBeenCalledWith({ redirectUri: 'https://staging.example/admin-invitation' });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('never retains invitation context when its fragment is mixed with provider credentials', async () => {
    sessionStorage.setItem(key, JSON.stringify({ token, capturedAt: now().toISOString() }));
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}&access_token=provider-canary`);
    const original = window.location.href; const { sdk, options } = runtime(true);
    let finish!: () => void; sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = createLiffBootstrap(options)(); await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    expect(window.location.href).toBe(original); expect(sessionStorage.getItem(key)).toBeNull();
    finish(); await pending; expect(window.location.href).toBe(original);
  });
  it('discards an own fragment restored by a provider redirect only after initialization resolves', async () => {
    window.history.replaceState(null, '', '/admin-invitation?liff.state=synthetic#access_token=provider-canary');
    const { sdk, options } = runtime(); sdk.init.mockImplementation(async () => {
      window.history.replaceState(null, '', `/admin-invitation#invite=${token}`);
    });
    await createLiffBootstrap(options)();
    expect(window.location.hash).toBe(''); expect(sessionStorage.getItem(key)).toBeNull();
    expect(sdk.login).toHaveBeenCalledWith({ redirectUri: 'https://staging.example/admin-invitation' });
  });
  it('cleans a cancelled attempt’s own provider fragment after init, without reading a token or logging in', async () => {
    window.history.replaceState(null, '', `/admin-invitation?liff.state=synthetic#invite=${token}`);
    const { sdk, options } = runtime(); const getIDToken = vi.spyOn(sdk, 'getIDToken'); const controller = new AbortController();
    let finish!: () => void; sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const result = createLiffBootstrap({ ...options, signal: controller.signal })().catch(error => error);
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled()); expect(window.location.hash).toContain(token);
    controller.abort(); finish(); await result;
    expect(window.location.hash).toBe(''); expect(window.location.search).toBe('?liff.state=synthetic');
    expect(sdk.login).not.toHaveBeenCalled(); expect(getIDToken).not.toHaveBeenCalled(); expect(options.fetch).toHaveBeenCalledOnce();
  });
  it.each([token, 'b'.repeat(43)])('does not let a retired cancelled init clean the newer bootstrap URL/context for %s', async newerToken => {
    window.history.replaceState(null, '', `/admin-invitation?liff.state=old#invite=${token}`);
    const old = runtime(); const controller = new AbortController(); let finishOld!: () => void;
    old.sdk.init.mockImplementation(() => new Promise<void>(resolve => { finishOld = resolve; }));
    const oldResult = createLiffBootstrap({ ...old.options, signal: controller.signal })().catch(error => error);
    await vi.waitFor(() => expect(old.sdk.init).toHaveBeenCalled()); controller.abort();
    window.history.replaceState(null, '', `/admin-invitation?liff.state=new#invite=${newerToken}`);
    const newer = runtime(); let finishNew!: () => void;
    newer.sdk.init.mockImplementation(() => new Promise<void>(resolve => { finishNew = resolve; }));
    const newResult = createLiffBootstrap(newer.options)(); await vi.waitFor(() => expect(newer.sdk.init).toHaveBeenCalled());
    sessionStorage.setItem(key, JSON.stringify({ token: newerToken, capturedAt: now().toISOString() }));
    finishOld(); await oldResult;
    expect(window.location.hash).toBe(`#invite=${newerToken}`); expect(window.location.search).toBe('?liff.state=new');
    expect(readInvitationContext(sessionStorage, now())?.token).toBe(newerToken); expect(old.sdk.login).not.toHaveBeenCalled();
    finishNew(); await newResult;
  });
  it('does not turn an unrelated fragment or arbitrary route into an invitation login target', async () => {
    window.history.replaceState(null, '', `/elsewhere#invite=${token}`); const { sdk, options } = runtime();
    await createLiffBootstrap(options)(); expect(sdk.login).toHaveBeenCalledWith({ redirectUri: 'https://staging.example/' });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('uses the clean invitation target for explicit rejected-token recovery', async () => {
    window.history.replaceState(null, '', `/admin-invitation#invite=${token}`); const { sdk, options } = runtime(true);
    options.fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }));
    const error = await createLiffBootstrap(options)().catch(value => value);
    error.recovery.run(); expect(sdk.login).toHaveBeenCalledWith({ redirectUri: 'https://staging.example/admin-invitation' });
    expect(JSON.stringify(sdk.login.mock.calls)).not.toContain(token);
  });
});
