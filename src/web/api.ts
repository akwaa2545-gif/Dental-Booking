import type { ErrorCode, Session } from '../shared/contracts';
import { bookingRange } from '../shared/calendar';
import { claimInvitationRequestSchema, managementCursorSchema, ownClaimSchema, pageSchema, type OwnClaim, type Page } from '../shared/admin-management';

/** UI port; the demo adapter implements this without network requests. */
export interface ApiClient { readonly dataMode?: 'demo' | 'server'; request<T>(path: string, init?: RequestInit): Promise<T> }
/** Only actual response statuses may be displayed as HTTP diagnostics. */
export function safeResponseStatus(value: unknown): number | undefined {
  return typeof value === 'number' && [200, 201, 204, 400, 401, 403, 404, 405, 408, 409, 413, 415, 422, 429, 500, 502, 503, 504].includes(value) ? value : undefined;
}
export class ApiRequestError extends Error {
  readonly responseStatus: number | undefined;
  constructor(public code: ErrorCode, public status = 409, responseStatus?: number) {
    super(code); this.name = 'ApiRequestError'; this.responseStatus = safeResponseStatus(responseStatus);
  }
}
export class SessionRefreshError extends ApiRequestError {
  readonly phase = 'session-refresh';
  constructor(error: unknown) {
    const failure = error instanceof ApiRequestError ? error : undefined;
    super(failure?.code ?? 'UNAVAILABLE', failure?.status ?? 503, failure?.responseStatus);
  }
}
export const ERROR_TEXT: Record<ErrorCode, string> = {
  VALIDATION: 'กรุณาตรวจสอบข้อมูลและช่องที่จำเป็น', UNAUTHENTICATED: 'เซสชันสิ้นสุด ตรวจสอบคำขอเดิมก่อนดำเนินการต่อ', FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้ กรุณาตรวจสอบบัญชีและสิทธิ์ผู้ดูแล', NOT_FOUND: 'ไม่พบนัดหมาย', FULL: 'วันนี้เต็มแล้ว โปรดเลือกวันใหม่ ข้อมูลอื่นยังอยู่', INELIGIBLE_DATE: 'เลือกวันจันทร์–ศุกร์ ล่วงหน้า 1–90 วัน', INTAKE_CLOSED: 'วันนี้หยุดหรือปิดรับคำขอ ยังอนุมัติไม่ได้', DUPLICATE: 'ผู้รับบริการนี้มีคำขอที่ยังใช้งานในวันเดียวกันแล้ว', VERSION_CONFLICT: 'สถานะเปลี่ยนแล้ว โปรดตรวจสอบข้อมูลล่าสุด', IDEMPOTENCY_CONFLICT: 'คำขอเดิมมีข้อมูลต่างกัน โปรดเริ่มคำขอใหม่', INVALID_TRANSITION: 'สถานะหรือเวลานี้ยังทำรายการไม่ได้', CUTOFF_PASSED: 'เลยกำหนดทำรายการแล้ว โปรดติดต่อคลินิก (ช่องทางจริงยังไม่ตั้งค่า)', UNRESOLVED_BOOKINGS: 'ยังปิดวันไม่ได้ มีคำขอรออนุมัติหรือนัดที่อนุมัติแล้วต้องจัดการก่อน', RATE_LIMITED: 'โปรดลองใหม่ภายหลัง', UNAVAILABLE: 'ยังไม่ทราบผล โปรดตรวจสอบคำขอเดิมก่อนส่งอีกครั้ง',
};
export function errorText(error: unknown): string { return error instanceof ApiRequestError ? ERROR_TEXT[error.code] : ERROR_TEXT.UNAVAILABLE; }

/** Validate server-produced data before any private UI is mounted. */
export function parseServerSession(value: unknown, now: Date): Session {
  if (!value || typeof value !== 'object') throw new ApiRequestError('UNAVAILABLE', 503);
  const session = value as Partial<Session>;
  if (typeof session.accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.accountId)
    || typeof session.csrfToken !== 'string' || !session.csrfToken.length
    || typeof session.isAdmin !== 'boolean' || typeof session.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now.getTime()) throw new ApiRequestError('UNAVAILABLE', 503);
  return { accountId: session.accountId, csrfToken: session.csrfToken, isAdmin: session.isAdmin, expiresAt: session.expiresAt };
}

/** Same-origin, in-memory client. It never persists input or automatically retries writes. */
export interface BrowserApi extends ApiClient { dispose(): void; refreshSession(): Promise<Session> }
export function createBrowserApi(options: {
  fetch?: typeof fetch; now?: () => Date; accountId?: string;
  onSession?: (session: Session) => void;
  onSessionInvalid?: (error: ApiRequestError) => void;
} = {}): BrowserApi {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  let boundAccount = options.accountId;
  let disposed = false;
  function requireActive() { if (disposed) throw new ApiRequestError('UNAUTHENTICATED', 401); }
  async function send<T>(path: string, init: RequestInit = {}): Promise<{ body: T; status: number }> {
    requireActive();
    let response: Response;
    try {
      response = await fetcher(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch { throw new ApiRequestError('UNAVAILABLE', 503); }
    requireActive();
    if (response.status === 204 && response.ok) return { body: undefined as T, status: response.status };
    let body: unknown;
    try { body = await response.json(); } catch { throw new ApiRequestError('UNAVAILABLE', 503, response.status); }
    requireActive();
    if (!response.ok) {
      const candidate = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      const code = candidate && typeof candidate === 'object' && 'code' in candidate ? candidate.code : undefined;
      throw new ApiRequestError(typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code) ? code as ErrorCode : 'UNAVAILABLE', response.status, response.status);
    }
    return { body: body as T, status: response.status };
  }
  async function refreshSession(signal?: AbortSignal | null, notifyInvalid = true): Promise<Session> {
    try {
      const response = await send<unknown>('/api/session', { signal });
      let session: Session;
      try { session = parseServerSession(response.body, now()); }
      catch { throw new ApiRequestError('UNAVAILABLE', 503, response.status); }
      if (boundAccount && boundAccount !== session.accountId) throw new ApiRequestError('UNAUTHENTICATED', 401, response.status);
      boundAccount = session.accountId;
      options.onSession?.(session);
      requireActive();
      return session;
    } catch (error) {
      const failure = new SessionRefreshError(error);
      if (!disposed && notifyInvalid) options.onSessionInvalid?.(failure);
      throw failure;
    }
  }
  return {
    dataMode: 'server',
    // The foreground boundary owns this failure, so it can label it without racing a callback.
    refreshSession: () => refreshSession(undefined, false),
    dispose() { disposed = true; },
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      requireActive();
      // Never turn a caller-controlled URL into a credentialed cross-origin request.
      const pathname = path.split('?')[0];
      if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(pathname) || path.includes('#') || path.includes('\\')) throw new ApiRequestError('VALIDATION', 400);
      if (path === '/api/availability') {
        const range = bookingRange(now());
        path += `?from=${range.min}&to=${range.max}`;
      }
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      if (pathname !== '/api/availability' || method !== 'GET') {
        // Fresh session prevents a stale CSRF token after explicit reauthentication.
        // Failure or an uncertain response is returned to the UI, never replayed here.
        const session = await refreshSession(init.signal);
        if (path === '/api/session' && method === 'GET') return session as T;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          headers.set('X-CSRF-Token', session.csrfToken);
          headers.set('Content-Type', 'application/json');
        }
      }
      try { return (await send<T>(path, { ...init, method, headers })).body; }
      catch (error) {
        if (!disposed && error instanceof ApiRequestError && [401, 403].includes(error.status)) options.onSessionInvalid?.(error);
        throw error;
      }
    },
  };
}

export type ApprovedNotificationTestResult={status:'accepted'|'unknown'|'failed'|'not_sent';attempted:boolean};
/** Fixed consented staging operation; no recipient, key or payload from the UI. */
export async function sendApprovedNotificationTest(api:ApiClient):Promise<ApprovedNotificationTestResult>{
 const value=await api.request<unknown>('/api/admin/line/test-approval',{method:'POST',body:'{}'});
 if(!value||typeof value!=='object'||!('status' in value)||!('attempted' in value)
  ||typeof value.status!=='string'||!['accepted','unknown','failed','not_sent'].includes(value.status)||typeof value.attempted!=='boolean')throw new ApiRequestError('UNAVAILABLE',503);
 return{status:value.status as ApprovedNotificationTestResult['status'],attempted:value.attempted};
}

/** Only an operator-verified, public OA address may be configured. No tracking or patient parameters. */
export function verifiedOaLink(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\/(?:line\.me\/R\/ti\/p\/(?:@|%40)[A-Za-z0-9_.-]+|lin\.ee\/[A-Za-z0-9]+)$/.test(value) ? value : undefined;
}

/** Recipient endpoints return direct DTOs, not store-result envelopes. */
export async function claimAdminInvitation(api: ApiClient, token: string): Promise<OwnClaim> {
  const input = claimInvitationRequestSchema.safeParse({ token });
  if (!input.success) throw new ApiRequestError('VALIDATION', 400);
  const value = await api.request<unknown>('/api/admin-invitations/claim', { method: 'POST', body: JSON.stringify(input.data) });
  const result = ownClaimSchema.safeParse(value);
  if (!result.success) throw new ApiRequestError('UNAVAILABLE', 503);
  return result.data;
}
export async function listOwnAdminClaims(api: ApiClient, cursor: string | null = null): Promise<Page<OwnClaim>> {
  const input = managementCursorSchema.nullable().safeParse(cursor);
  if (!input.success) throw new ApiRequestError('VALIDATION', 400);
  const path = '/api/admin-invitations/mine' + (input.data === null ? '' : `?cursor=${encodeURIComponent(input.data)}`);
  const value = await api.request<unknown>(path);
  const result = pageSchema(ownClaimSchema).safeParse(value);
  if (!result.success) throw new ApiRequestError('UNAVAILABLE', 503);
  return result.data;
}
