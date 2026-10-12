import type { Session } from '../shared/contracts';
import { prepareInvitationBootstrap } from './invitations/context';
import { ApiRequestError, ERROR_TEXT, parseServerSession, safeResponseStatus } from './api';

/** Small SDK surface: decoded client identity and profile claims never authorize anything. */
export interface LiffSdk {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  isInClient(): boolean;
  login(config: { redirectUri: string }): void;
  getIDToken(): string | null;
  logout(): void;
  closeWindow(): void;
}
export type LiffBootstrapOptions = {
  liffId: string;
  staging: boolean;
  origin: string;
  fetch?: typeof fetch;
  now?: () => Date;
  loadSdk?: () => Promise<LiffSdk>;
  signal?: AbortSignal;
};
export type LiffSession = { session: Session; sdk: LiffSdk; tokenFingerprint: string };

/** A one-shot user action, never an authorization claim or a retained token. */
export type LiffAuthRecovery = { readonly kind: 'external-login' | 'reopen-liff'; readonly run?: () => void };

// Keep this closure outside bootstrap so it cannot retain a token or response body.
function rejectedTokenRecovery(sdk: LiffSdk, redirectUri: string): LiffAuthRecovery {
  let inClient: boolean;
  try { inClient = sdk.isInClient(); }
  catch { return { kind: 'reopen-liff' }; }
  let attempted = false;
  return {
    kind: inClient ? 'reopen-liff' : 'external-login',
    run() {
      if (attempted) return;
      attempted = true;
      try {
        if (inClient) sdk.closeWindow();
        else { sdk.logout(); sdk.login({ redirectUri }); }
      } catch { throw new ApiRequestError('UNAVAILABLE', 503); }
    },
  };
}

export type AuthDiagnostic = 'A01' | 'A02' | 'A03' | 'A04' | 'A05' | 'A06' | 'A07' | 'A08' | 'A09';
/** Safe metadata and a bounded action only: never retain provider messages, identity, or response bodies. */
export class LiffAuthError extends ApiRequestError {
  readonly serverDiagnostic: 'A10' | 'A11' | undefined;
  readonly recovery: LiffAuthRecovery | undefined;
  constructor(readonly diagnostic: AuthDiagnostic, error?: unknown, responseStatus?: number, serverDiagnostic?: unknown, recovery?: LiffAuthRecovery) {
    const failure = error instanceof ApiRequestError ? error : undefined;
    const code = failure && typeof failure.code === 'string' && Object.hasOwn(ERROR_TEXT, failure.code) ? failure.code : 'UNAVAILABLE';
    super(code, safeResponseStatus(failure?.status) ?? 503, responseStatus ?? failure?.responseStatus);
    this.serverDiagnostic = diagnostic === 'A06' && this.responseStatus === 503 && code === 'UNAVAILABLE'
      && (serverDiagnostic === 'A10' || serverDiagnostic === 'A11') ? serverDiagnostic : undefined;
    this.recovery = diagnostic === 'A06' && this.responseStatus === 401 && code === 'UNAUTHENTICATED' ? recovery : undefined;
  }
}
export function authDiagnosticText(error: LiffAuthError): string {
  return [error.diagnostic, ...(error.responseStatus === undefined ? [] : [`HTTP ${error.responseStatus}`]), error.code,
    ...(error.serverDiagnostic ? [error.serverDiagnostic] : [])].join(' · ');
}

/** Initial readiness errors must not be presented as an uncertain booking write. */
export class LiffSetupUnavailableError extends ApiRequestError {
  readonly phase = 'setup';
  constructor() { super('UNAVAILABLE', 503); }
}

async function requireBackendReady(fetcher: typeof fetch, now: () => Date): Promise<void> {
  try {
    const response = await fetcher('/api/session', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000),
    });
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new LiffSetupUnavailableError();
    const body: unknown = await response.json();
    if (response.status === 200) { parseServerSession(body, now()); return; }
    if (response.status === 401 && body && typeof body === 'object' && 'error' in body
      && body.error && typeof body.error === 'object' && 'code' in body.error && body.error.code === 'UNAUTHENTICATED') return;
    throw new LiffSetupUnavailableError();
  } catch { throw new LiffSetupUnavailableError(); }
}

/** Detect token/account changes conservatively; this hash never supplies authorization claims. */
export async function fingerprintLiffToken(token: string | null): Promise<string> {
  if (!token) throw new ApiRequestError('UNAUTHENTICATED', 401);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** One attempt only, including StrictMode effect replays. New attempts require a user action. */
export function createLiffBootstrap(options: LiffBootstrapOptions): () => Promise<LiffSession | null> {
  let pending: Promise<LiffSession | null> | undefined;
  async function bootstrap(): Promise<LiffSession | null> {
    // Direct invitation secrets are removed before readiness checks or SDK load.
    // Provider redirect URLs remain untouched until the SDK has finished init.
    let invitation: ReturnType<typeof prepareInvitationBootstrap>;
    try { invitation = prepareInvitationBootstrap((options.now ?? (() => new Date()))()); }
    catch { throw new LiffSetupUnavailableError(); }
    let origin: URL;
    try {
      origin = new URL(options.origin);
      if (!options.staging || !/^\d+-[A-Za-z0-9]+$/.test(options.liffId) || origin.protocol !== 'https:' || origin.origin !== options.origin) throw new LiffSetupUnavailableError();
    } catch { throw new LiffSetupUnavailableError(); }
    function requireCurrentAttempt() { if (options.signal?.aborted) throw new ApiRequestError('UNAUTHENTICATED', 401); }
    requireCurrentAttempt();
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    await requireBackendReady(fetcher, options.now ?? (() => new Date()));
    requireCurrentAttempt();
    let diagnostic: AuthDiagnostic = 'A01';
    let responseStatus: number | undefined;
    try {
      const sdk = await (options.loadSdk ?? (async () => (await import('./liff-sdk')).default))();
      requireCurrentAttempt();
      // Provider redirect state stays intact until LIFF initialization resolves.
      diagnostic = 'A02';
      await sdk.init({ liffId: options.liffId });
      invitation.afterInit();
      requireCurrentAttempt();
      const redirectUri = `${origin.origin}${invitation.returnPath}`;
      diagnostic = 'A03';
      if (!sdk.isLoggedIn()) {
        if (sdk.isInClient()) throw new ApiRequestError('UNAUTHENTICATED', 401);
        sdk.login({ redirectUri });
        return null;
      }
      let idToken = sdk.getIDToken();
      if (!idToken || idToken.length > 12000) throw new ApiRequestError('UNAUTHENTICATED', 401);
      diagnostic = 'A04';
      const tokenFingerprint = await fingerprintLiffToken(idToken);
      requireCurrentAttempt();
      diagnostic = 'A05';
      let response: Response;
      try {
        response = await fetcher('/api/auth/liff', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        });
      } finally { idToken = null; }
      requireCurrentAttempt();
      diagnostic = 'A06';
      responseStatus = response.status;
      const body: unknown = await response.json();
      requireCurrentAttempt();
      if (!response.ok) {
        const detail = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error : undefined;
        const code = detail && 'code' in detail ? detail.code : undefined;
        const serverDiagnostic = code === 'UNAVAILABLE' && detail && 'diagnostic' in detail ? detail.diagnostic : undefined;
        const recovery = response.status === 401 && code === 'UNAUTHENTICATED' ? rejectedTokenRecovery(sdk, redirectUri) : undefined;
        throw new LiffAuthError('A06', new ApiRequestError(typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code) ? code as keyof typeof ERROR_TEXT : 'UNAVAILABLE', response.status), response.status, serverDiagnostic, recovery);
      }
      diagnostic = 'A07';
      return { session: parseServerSession(body, (options.now ?? (() => new Date()))()), sdk, tokenFingerprint };
    } catch (error) {
      throw error instanceof LiffAuthError ? error : new LiffAuthError(diagnostic, error, responseStatus);
    }
  }
  return () => pending ??= bootstrap();
}
