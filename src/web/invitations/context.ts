const KEY = 'toothtalk.admin-invitation.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// A partial storage denial must not make an old bearer look like a new link.
const deniedStorage = new WeakSet<Storage>();
type InvitationContext = { token: string; capturedAt: string };
let bootstrapGeneration = 0;

/** Tab storage can be disabled independently of the rest of the browser. */
export function invitationStorage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}
export function clearInvitationContext(storage: Storage): void {
  // Returning from removeItem is not evidence that a no-op adapter removed it.
  deniedStorage.add(storage);
  try { storage.removeItem(KEY); if (storage.getItem(KEY) === null) deniedStorage.delete(storage); }
  catch { /* The document-lifetime denial fence stays in place. */ }
}
export function readInvitationContext(storage: Storage, now: Date): InvitationContext | null {
  if (deniedStorage.has(storage)) return null;
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !('token' in value) || typeof value.token !== 'string' || !TOKEN.test(value.token)
      || !('capturedAt' in value) || typeof value.capturedAt !== 'string') throw new Error();
    const capturedAt = Date.parse(value.capturedAt), age = now.getTime() - capturedAt;
    if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE_MS || new Date(capturedAt).toISOString() !== value.capturedAt) throw new Error();
    return { token: value.token, capturedAt: value.capturedAt };
  } catch { clearInvitationContext(storage); return null; }
}
function isOwnFragment(location: Location): boolean {
  return location.pathname === '/admin-invitation' && location.hash.startsWith('#invite=')
    && !/(?:^|[&#])(?:access_token|id_token|token_type|liff\.[^=]*)=/.test(location.hash);
}
/** Only an ordinary, direct app link may be changed before LIFF initializes.
 * Primary redirects and provider-owned fragments are never parsed as tokens. */
export function captureInvitationContext(location: Location, history: History, storage: Storage, now: Date): void {
  if (location.search || !isOwnFragment(location)) return;
  const token = location.hash.slice('#invite='.length);
  // Remove first, including when persistence is denied or the token is invalid.
  history.replaceState(null, '', location.pathname);
  clearInvitationContext(storage);
  if (!TOKEN.test(token) || !Number.isFinite(now.getTime())) return;
  try {
    const serialized = JSON.stringify({ token, capturedAt: now.toISOString() });
    storage.setItem(KEY, serialized);
    // Positively verify this exact new context, independently of the read fence.
    if (storage.getItem(KEY) === serialized) deniedStorage.delete(storage);
    else { clearInvitationContext(storage); deniedStorage.add(storage); }
  } catch { clearInvitationContext(storage); deniedStorage.add(storage); }
}

/** No secret in a LIFF/OAuth URL. A mixed provider redirect fails closed:
 * preserve the complete URL until init resolves, then discard only our fragment. */
export function prepareInvitationBootstrap(now: Date): { returnPath: '/' | '/admin-invitation'; afterInit: () => void } {
  const generation = ++bootstrapGeneration;
  const storage = invitationStorage();
  const returnPath = window.location.pathname === '/admin-invitation' ? '/admin-invitation' : '/';
  const providerRedirect = !!window.location.search || /(?:^|[&#])(?:access_token|id_token|token_type|liff\.[^=]*)=/.test(window.location.hash);
  const deferredOwnFragment = providerRedirect && window.location.pathname === '/admin-invitation' && window.location.hash.startsWith('#invite=');
  if (storage) {
    readInvitationContext(storage, now);
    if (deferredOwnFragment) clearInvitationContext(storage);
    else captureInvitationContext(window.location, window.history, storage, now);
  } else if (!window.location.search && isOwnFragment(window.location)) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return { returnPath, afterInit() {
    // Initialization may finish after cancellation. Clean only while this is
    // still the latest bootstrap; a retired init cannot touch a newer URL/tab context.
    if (generation === bootstrapGeneration && providerRedirect && isOwnFragment(window.location)) {
      if (storage) clearInvitationContext(storage);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  } };
}
