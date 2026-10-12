import { z } from 'zod';
import {
  approveInvitationRequestSchema, claimInvitationRequestSchema, closeInvitationRequestSchema,
  createInvitationRequestSchema, managementCursorSchema, parseManagementCursor, revokeAdminGrantRequestSchema,
  type AdminRosterEntry, type InvitationSummary, type ManagementAuditEntry, type OwnClaim, type Page,
} from '../shared/admin-management';
import { ApiRequestError } from '../web/api';
import { createManagementFixtures } from './fixtures';
import type { DemoRole } from './api';

type Row = { summary: InvitationSummary; issuer: string; issuerGrantId: string; token: string; claimant: string | null; code: string | null; attempts: number; approver: string | null; closedBy: string | null };
function fail(code: ApiRequestError['code'], status = 409): never { throw new ApiRequestError(code, status); }
function input<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) fail('VALIDATION', 400); return parsed.data; }
function newToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function newCode() { let code = ''; while (code.length < 8) { const byte = crypto.getRandomValues(new Uint8Array(1))[0]; if (byte < 250) code += byte % 10; } return code; }
/** Local-only simulation: no server store, persistence, provider lookup, login or outbound request. */
export function createDemoManagement({ now, role, origin }: { now: () => Date; role: () => DemoRole; origin: () => string }) {
  const seedTime = now();
  let grants = createManagementFixtures(seedTime).grants;
  let rows: Row[] = [createManagementFixtures(seedTime).pending]; let history: ManagementAuditEntry[] = [];
  let requests = new Map<string, { fingerprint: string; row: Row }>();
  const actor = () => role() === 'other' ? 'B' : role() === 'owner' ? 'OWNER' : 'A';
  const activeGrant = (who: string) => grants.find(grant => grant.actor === who && grant.revokedAt === null);
  const isAdmin = () => role() !== 'patient' && !!activeGrant(actor());
  const owner = () => isAdmin() && !!activeGrant(actor())?.protectedOwner;
  function admin() { if (!isAdmin()) fail('FORBIDDEN', 403); }
  const reference = (who: string) => grants.find(grant => grant.actor === who)?.reference ?? `AC-DEMO-${who}`;
  function effective(row: Row) {
    if (!['issued', 'claimed'].includes(row.summary.state)) return row.summary.state;
    if (!grants.some(grant => grant.id === row.issuerGrantId && grant.revokedAt === null)) return 'invalidated';
    return now().getTime() >= Date.parse(row.summary.expiresAt) ? 'expired' : row.summary.state;
  }
  function summary(row: Row): InvitationSummary {
    const state = effective(row);
    return { ...row.summary, state, canClose: isAdmin() && ['issued', 'claimed'].includes(row.summary.state) && (owner() || row.issuer === actor() && ['issued', 'claimed'].includes(state)) };
  }
  function audit(action: string, row: Row | null, target: string | null, grantId: string | null, reason: string | null = null) {
    history.push({ id: crypto.randomUUID(), action, actorReference: reference(actor()), targetReference: target ? reference(target) : null, invitationId: row?.summary.id ?? null, grantId, reason, occurredAt: now().toISOString() });
  }
  function paged<T>(items: T[], cursor: string | null, key: (row: T) => { at: string; id: string }): Page<T> {
    const pair = parseManagementCursor(cursor);
    const ordered = [...items].sort((a, b) => key(b).at.localeCompare(key(a).at) || key(b).id.localeCompare(key(a).id));
    const filtered = pair ? ordered.filter(row => key(row).at < pair.occurredAt || key(row).at === pair.occurredAt && key(row).id < pair.id) : ordered;
    const result = filtered.slice(0, 50), last = result.at(-1);
    const nextCursor = filtered.length > 50 && last ? btoa(JSON.stringify({ occurredAt: key(last).at, id: key(last).id })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') : null;
    return { items: result, nextCursor };
  }
  return {
    isAdmin,
    reset() { grants = createManagementFixtures(seedTime).grants; rows = [createManagementFixtures(seedTime).pending]; history = []; requests = new Map(); },
    handle(url: URL, method: string, body: unknown): unknown {
      const root = '/api/admin/management', path = url.pathname;
      if (!path.startsWith(root + '/') && !path.startsWith('/api/admin-invitations/')) return undefined;
      const list = method === 'GET' && [`${root}/roster`, `${root}/invitations`, `${root}/history`, '/api/admin-invitations/mine'].includes(path);
      if ([...url.searchParams.keys()].some(key => !list || key !== 'cursor' || url.searchParams.getAll(key).length !== 1)) fail('VALIDATION', 400);
      const cursor = input(managementCursorSchema.nullable(), url.searchParams.get('cursor'));
      const manager = path.startsWith(root + '/'); if (manager) admin();
      if (method === 'GET' && path === `${root}/capabilities`) return { canRevokeAdmins: owner() };
      if (method === 'GET' && path === `${root}/roster`) {
        const items: AdminRosterEntry[] = grants.filter(grant => grant.revokedAt === null).map(grant => ({ grantId: grant.id, reference: grant.reference, label: grant.label, grantedAt: grant.grantedAt, protectedOwner: grant.protectedOwner, canRevoke: owner() && !grant.protectedOwner && grant.actor !== actor() }));
        return paged(items, cursor, row => ({ at: row.grantedAt, id: row.grantId }));
      }
      if (method === 'GET' && path === `${root}/invitations`) return paged(rows.map(summary), cursor, row => ({ at: row.createdAt, id: row.id }));
      if (method === 'GET' && path === `${root}/history`) return paged(history, cursor, row => ({ at: row.occurredAt, id: row.id }));
      if (method === 'GET' && path === '/api/admin-invitations/mine') {
        const items: OwnClaim[] = rows.filter(row => row.claimant === actor()).map(row => ({ invitation: { ...summary(row), canClose: false }, verificationCode: effective(row) === 'claimed' ? row.code : null }));
        return paged(items, cursor, row => ({ at: row.invitation.createdAt, id: row.invitation.id }));
      }
      if (method === 'POST' && path === `${root}/invitations`) {
        const fields = input(createInvitationRequestSchema, body), token = newToken();
        // Each HTTP create gets a fresh bearer, just like the Worker. Reusing a
        // request key usually conflicts with that new token, even for identical fields.
        const key = `${actor()}:${fields.requestId}`, fingerprint = JSON.stringify({ ...fields, token }), previous = requests.get(key);
        if (previous) { if (previous.fingerprint !== fingerprint) fail('DUPLICATE'); return { created: false, invitation: summary(previous.row) }; }
        if (rows.filter(row => row.issuer === actor() && now().getTime() - Date.parse(row.summary.createdAt) < 86400000).length >= 20) fail('RATE_LIMITED', 429);
        const createdAt = now().toISOString(), expiresAt = new Date(now().getTime() + 86400000).toISOString();
        const row: Row = { summary: { id: crypto.randomUUID(), label: fields.label, reason: fields.reason, state: 'issued', version: 1, createdAt, expiresAt, claimedAt: null, claimReference: null, canClose: true }, issuer: actor(), issuerGrantId: activeGrant(actor())!.id, token, claimant: null, code: null, attempts: 0, approver: null, closedBy: null };
        rows.push(row); requests.set(key, { fingerprint, row }); audit('invitation_created', row, null, null, fields.reason);
        return { created: true, invitation: summary(row), invitationUrl: `${origin()}/admin-invitation#invite=${row.token}` };
      }
      if (method === 'POST' && path === '/api/admin-invitations/claim') {
        const fields = input(claimInvitationRequestSchema, body), row = rows.find(row => row.token === fields.token);
        if (!row || row.claimant && row.claimant !== actor()) fail('NOT_FOUND', 404);
        if (row.claimant === actor() && ['approved', 'rejected', 'cancelled', 'locked'].includes(row.summary.state)) return { invitation: { ...summary(row), canClose: false }, verificationCode: null };
        if (!['issued', 'claimed'].includes(effective(row))) fail('NOT_FOUND', 404);
        if (row.claimant === actor()) return { invitation: { ...summary(row), canClose: false }, verificationCode: row.code };
        row.claimant = actor(); row.code = newCode(); row.summary = { ...row.summary, state: 'claimed', version: row.summary.version + 1, claimedAt: now().toISOString(), claimReference: `AC-DEMO-${crypto.randomUUID().slice(0, 8)}` }; audit('invitation_claimed', row, actor(), null);
        return { invitation: { ...summary(row), canClose: false }, verificationCode: row.code };
      }
      const action = method === 'POST' ? new RegExp(`^${root}/invitations/([^/]+)/(approve|close)$`).exec(path) : null;
      if (action) {
        const id = input(z.uuid(), action[1]); const fields = action[2] === 'approve' ? input(approveInvitationRequestSchema, body) : input(closeInvitationRequestSchema, body);
        const row = rows.find(row => row.summary.id === id); if (!row) fail('NOT_FOUND', 404);
        if (action[2] === 'close' && !owner() && (row.issuer !== actor() || row.issuerGrantId !== activeGrant(actor())?.id)) fail('FORBIDDEN', 403);
        if (action[2] === 'approve' && row.summary.state === 'approved' && row.approver === actor() && fields.version === row.summary.version - 1) return summary(row);
        const desired = 'action' in fields ? fields.action === 'cancel' ? 'cancelled' : 'rejected' : 'approved';
        if (action[2] === 'close' && row.summary.state === desired && row.closedBy === actor() && fields.version === row.summary.version - 1) return summary(row);
        if (!['issued', 'claimed'].includes(row.summary.state)) fail('INVALID_TRANSITION');
        if (!['issued', 'claimed'].includes(effective(row)) && !(action[2] === 'close' && owner())) fail('NOT_FOUND', 404);
        if (fields.version !== row.summary.version) fail('VERSION_CONFLICT');
        if ('verificationCode' in fields) {
          if (row.summary.state !== 'claimed' || !row.claimant) fail('INVALID_TRANSITION');
          if (fields.verificationCode !== row.code) {
            row.attempts++; row.summary.version++; if (row.attempts >= 5) { row.summary.state = 'locked'; row.code = null; }
            audit('invitation_verification_failed', row, row.claimant, null); fail('INVALID_TRANSITION');
          }
          if (activeGrant(row.claimant)) fail('DUPLICATE');
          const grant = { id: crypto.randomUUID(), actor: row.claimant, label: row.summary.label, reference: `AD-DEMO-${row.claimant}`, grantedAt: now().toISOString(), revokedAt: null, protectedOwner: false };
          grants.push(grant); row.approver = actor(); audit('invitation_approved', row, row.claimant, grant.id);
        } else { row.closedBy = actor(); audit(`invitation_${desired}`, row, row.claimant, null, fields.reason); }
        row.summary.state = desired; row.summary.version++; row.code = null; return summary(row);
      }
      const revoke = method === 'POST' ? new RegExp(`^${root}/grants/([^/]+)/revoke$`).exec(path) : null;
      if (revoke) {
        const id = input(z.uuid(), revoke[1]), fields = input(revokeAdminGrantRequestSchema, body);
        if (!owner()) fail('FORBIDDEN', 403);
        const grant = grants.find(grant => grant.id === id); if (!grant) fail('NOT_FOUND', 404);
        if (grant.protectedOwner || grant.actor === actor()) fail('FORBIDDEN', 403);
        if (grant.revokedAt !== null) return { revoked: false };
        if (grants.filter(grant => grant.revokedAt === null).length <= 1) fail('INVALID_TRANSITION');
        grant.revokedAt = now().toISOString(); audit('admin_revoked', null, grant.actor, id, fields.reason); return { revoked: true };
      }
      fail('NOT_FOUND', 404);
    },
  };
}
