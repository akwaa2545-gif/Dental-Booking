import { z } from 'zod';
import {
  adminManagementCapabilitiesSchema, adminRosterEntrySchema, approveInvitationRequestSchema,
  claimInvitationRequestSchema, closeInvitationRequestSchema, createdInvitationSchema,
  createInvitationRequestSchema, invitationSummarySchema, managementAuditEntrySchema,
  managementCursorSchema, managementResultSchema, ownClaimSchema, pageSchema,
  revokeAdminGrantRequestSchema, revokedAdminGrantSchema,
  type AdminManagementStore, type ManagementResult,
} from '../../shared/admin-management';
import type { Session } from '../../shared/contracts';
import { DatabaseError } from '../db';
import { errorResponse, json, readJson } from '../http';
import { hashInvitationToken, newInvitationToken, newVerificationCode } from './tokens';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DatabaseError('VALIDATION');
  return parsed.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DatabaseError('UNAVAILABLE');
  return parsed.data;
}
function exactQuery(url: URL, paginated: boolean): string | null {
  if ([...url.searchParams.keys()].some(key => !paginated || key !== 'cursor' || url.searchParams.getAll(key).length !== 1)) throw new DatabaseError('VALIDATION');
  return paginated ? input(managementCursorSchema.nullable(), url.searchParams.get('cursor')) : null;
}
function resultResponse<T>(result: ManagementResult<T>, recipient = false): Response {
  if (result.ok) return json(result.value);
  // Claim existence, claimant identity, expiry and issuer revocation share one
  // recipient response. The matching code and stale version never escape here.
  if (recipient && result.code !== 'RATE_LIMITED') return errorResponse(new DatabaseError('NOT_FOUND'));
  return errorResponse(new DatabaseError(result.code), recipient ? undefined : result);
}

/** makeApp has verified the session, CSRF on writes and a fresh manager grant.
 * The store repeats SQL authority checks. No identity is taken from the body. */
export async function handleAdminManagementRequest(request: Request, session: Session, store: AdminManagementStore | undefined, appOrigin: string): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  const read = request.method === 'GET' ? /^\/api\/admin\/management\/(capabilities|roster|invitations|history)$/.exec(path) : null;
  const create = request.method === 'POST' && path === '/api/admin/management/invitations';
  const invitationAction = request.method === 'POST' ? /^\/api\/admin\/management\/invitations\/([^/]+)\/(approve|close)$/.exec(path) : null;
  const revoke = request.method === 'POST' ? /^\/api\/admin\/management\/grants\/([^/]+)\/revoke$/.exec(path) : null;
  const claim = request.method === 'POST' && path === '/api/admin-invitations/claim';
  const ownClaims = request.method === 'GET' && path === '/api/admin-invitations/mine';
  if (!read && !create && !invitationAction && !revoke && !claim && !ownClaims) return null;
  if (!store) throw new DatabaseError('UNAVAILABLE');
  const cursor = exactQuery(url, ownClaims || !!read && read[1] !== 'capabilities');
  const actor = input(z.uuid(), session.accountId);
  if (read) {
    switch (read[1]) {
      case 'capabilities': return json(output(adminManagementCapabilitiesSchema, await store.capabilities(actor)));
      case 'roster': return json(output(pageSchema(adminRosterEntrySchema), await store.roster(actor, cursor)));
      case 'invitations': return json(output(pageSchema(invitationSummarySchema), await store.invitations(actor, cursor)));
      case 'history': return json(output(pageSchema(managementAuditEntrySchema), await store.history(actor, cursor)));
    }
  }
  if (ownClaims) return json(output(pageSchema(ownClaimSchema), await store.ownClaims(actor, cursor)));
  const body = await readJson(request);
  if (create) {
    const requested = input(createInvitationRequestSchema, body), token = newInvitationToken();
    const result = output(managementResultSchema(createdInvitationSchema), await store.create(actor, { ...requested, tokenHash: await hashInvitationToken(token) }));
    if (!result.ok) return resultResponse(result);
    // Lost-response/replay recovery returns metadata only. A new discarded
    // token must never be paired with a previously committed invitation ID.
    return result.value.created ? json({ ...result.value, invitationUrl: `${appOrigin}/admin-invitation#invite=${token}` }, 201) : json(result.value);
  }
  if (claim) {
    const requested = input(claimInvitationRequestSchema, body);
    try {
      const result = output(managementResultSchema(ownClaimSchema), await store.claim(actor, { tokenHash: await hashInvitationToken(requested.token), verificationCode: newVerificationCode() }));
      return resultResponse(result, true);
    } catch (error) {
      if (error instanceof DatabaseError && ['NOT_FOUND', 'FORBIDDEN', 'DUPLICATE', 'VERSION_CONFLICT', 'INVALID_TRANSITION'].includes(error.code)) return errorResponse(new DatabaseError('NOT_FOUND'));
      throw error;
    }
  }
  if (invitationAction) {
    const invitationId = input(z.uuid(), invitationAction[1]);
    if (invitationAction[2] === 'approve') {
      const requested = input(approveInvitationRequestSchema, body);
      return resultResponse(output(managementResultSchema(invitationSummarySchema), await store.approve(actor, { ...requested, invitationId })));
    }
    const requested = input(closeInvitationRequestSchema, body);
    return resultResponse(output(managementResultSchema(invitationSummarySchema), await store.close(actor, { ...requested, invitationId })));
  }
  const grantId = input(z.uuid(), revoke![1]), requested = input(revokeAdminGrantRequestSchema, body);
  return resultResponse(output(managementResultSchema(revokedAdminGrantSchema), await store.revoke(actor, { ...requested, grantId })));
}
