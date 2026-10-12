import { z } from 'zod';
import {
  adminManagementCapabilitiesSchema, adminRosterEntrySchema, approveInvitationInputSchema,
  claimInvitationInputSchema, closeInvitationInputSchema, createdInvitationSchema,
  createInvitationInputSchema, invitationSummarySchema, managementAuditEntrySchema,
  managementCursorSchema, managementResultSchema, ownClaimSchema, pageSchema,
  revokeAdminGrantInputSchema, revokedAdminGrantSchema, type AdminManagementStore,
} from '../../shared/admin-management';
import type { ErrorCode } from '../../shared/contracts';
import { DatabaseError, type QueryPort } from '../db';

// Match the existing database boundary's public business-error allowlist.
const safeErrors = new Set<ErrorCode>(['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'FULL', 'INELIGIBLE_DATE', 'INTAKE_CLOSED', 'DUPLICATE', 'IDEMPOTENCY_CONFLICT', 'INVALID_TRANSITION', 'CUTOFF_PASSED', 'UNRESOLVED_BOOKINGS', 'RATE_LIMITED']);
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DatabaseError('VALIDATION');
  return parsed.data;
}
/** Each call is one autocommitted SQL statement. Business failures are values:
 * converting them to HTTP errors must never roll back their counters or audit. */
export function createAdminManagementStore(port: QueryPort): AdminManagementStore {
  async function call<T>(sql: string, values: unknown[], schema: z.ZodType<T>): Promise<T> {
    let rows: { result: unknown }[];
    try {
      ({ rows } = await port.query(sql, values));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && 'message' in error
        && error.code === 'P0001' && safeErrors.has(error.message as ErrorCode)) {
        throw new DatabaseError(error.message as ErrorCode);
      }
      throw new DatabaseError('UNAVAILABLE');
    }
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) throw new DatabaseError('UNAVAILABLE');
    const parsed = schema.safeParse(rows[0].result);
    if (!parsed.success) throw new DatabaseError('UNAVAILABLE');
    return parsed.data;
  }
  const actor = (value: string) => input(z.uuid(), value);
  const cursor = (value: string | null) => input(managementCursorSchema.nullable(), value);
  return {
    async capabilities(id) {
      return call('select dental.admin_management_capabilities($1::uuid) as result', [actor(id)], adminManagementCapabilitiesSchema);
    },
    async roster(id, after) {
      return call('select dental.admin_management_roster($1::uuid, $2::text) as result', [actor(id), cursor(after)], pageSchema(adminRosterEntrySchema));
    },
    async invitations(id, after) {
      return call('select dental.admin_management_invitations($1::uuid, $2::text) as result', [actor(id), cursor(after)], pageSchema(invitationSummarySchema));
    },
    async history(id, after) {
      return call('select dental.admin_management_history($1::uuid, $2::text) as result', [actor(id), cursor(after)], pageSchema(managementAuditEntrySchema));
    },
    async ownClaims(id, after) {
      return call('select dental.admin_invitation_own_claims($1::uuid, $2::text) as result', [actor(id), cursor(after)], pageSchema(ownClaimSchema));
    },
    async create(id, requested) {
      return call('select dental.admin_management_create($1::uuid, $2::jsonb) as result', [actor(id), JSON.stringify(input(createInvitationInputSchema, requested))], managementResultSchema(createdInvitationSchema));
    },
    async claim(id, requested) {
      return call('select dental.admin_invitation_claim($1::uuid, $2::jsonb) as result', [actor(id), JSON.stringify(input(claimInvitationInputSchema, requested))], managementResultSchema(ownClaimSchema));
    },
    async approve(id, requested) {
      return call('select dental.admin_management_approve($1::uuid, $2::jsonb) as result', [actor(id), JSON.stringify(input(approveInvitationInputSchema, requested))], managementResultSchema(invitationSummarySchema));
    },
    async close(id, requested) {
      return call('select dental.admin_management_close($1::uuid, $2::jsonb) as result', [actor(id), JSON.stringify(input(closeInvitationInputSchema, requested))], managementResultSchema(invitationSummarySchema));
    },
    async revoke(id, requested) {
      return call('select dental.admin_management_revoke($1::uuid, $2::jsonb) as result', [actor(id), JSON.stringify(input(revokeAdminGrantInputSchema, requested))], managementResultSchema(revokedAdminGrantSchema));
    },
  };
}
