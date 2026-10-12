import { z } from 'zod';
import type { UUID } from './contracts';

export type InvitationState = 'issued' | 'claimed' | 'approved' | 'rejected' | 'cancelled' | 'locked' | 'expired' | 'invalidated';
export type InvitationSummary = {
  id: UUID;
  label: string;
  reason: string | null;
  state: InvitationState;
  version: number;
  expiresAt: string;
  createdAt: string;
  claimedAt: string | null;
  claimReference: string | null;
  canClose: boolean;
};
export type OwnClaim = { invitation: InvitationSummary; verificationCode: string | null };
export type AdminRosterEntry = { grantId: UUID; reference: string; label: string | null; grantedAt: string; protectedOwner: boolean; canRevoke: boolean };
export type ManagementAuditEntry = {
  id: UUID;
  action: string;
  actorReference: string;
  targetReference: string | null;
  invitationId: UUID | null;
  grantId: UUID | null;
  reason: string | null;
  occurredAt: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type ManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'DUPLICATE' | 'VERSION_CONFLICT' | 'RATE_LIMITED' | 'INVALID_TRANSITION'; version?: number; attemptsRemaining?: number };
export type CreatedInvitation = { invitation: InvitationSummary; created: boolean };
export type ManagementCursor = { occurredAt: string; id: UUID };

export const MANAGEMENT_PAGE_SIZE = 50;
const uuid = z.uuid();
const timestamp = z.string().max(35).pipe(z.iso.datetime({ offset: true }));
const label = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(1).max(500);
const version = z.number().int().min(1).max(2147483647);
const verificationCode = z.string().regex(/^[0-9]{8}$/);
const tokenHash = z.string().regex(/^[0-9a-f]{64}$/);
// References are application-generated display identifiers, never provider IDs.
const reference = z.string().min(1).max(80)
  .refine(value => !Array.from(value).some(char => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); }), 'Control characters are forbidden')
  .refine(value => !/^U[0-9a-f]{32}$/i.test(value), 'Provider subjects are forbidden');

export const invitationStateSchema = z.enum(['issued', 'claimed', 'approved', 'rejected', 'cancelled', 'locked', 'expired', 'invalidated']);
export const invitationSummarySchema: z.ZodType<InvitationSummary> = z.strictObject({
  id: uuid, label, reason: reason.nullable(), state: invitationStateSchema, version,
  expiresAt: timestamp, createdAt: timestamp, claimedAt: timestamp.nullable(),
  claimReference: reference.nullable(), canClose: z.boolean(),
});
export const ownClaimSchema: z.ZodType<OwnClaim> = z.strictObject({
  invitation: invitationSummarySchema,
  verificationCode: verificationCode.nullable(),
}).refine(value => value.verificationCode === null || value.invitation.state === 'claimed', 'Only a pending claim may expose a verification code');
export const adminRosterEntrySchema: z.ZodType<AdminRosterEntry> = z.strictObject({
  grantId: uuid, reference, label: label.nullable(), grantedAt: timestamp,
  protectedOwner: z.boolean(), canRevoke: z.boolean(),
});
export const managementAuditEntrySchema: z.ZodType<ManagementAuditEntry> = z.strictObject({
  id: uuid, action: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), actorReference: reference,
  targetReference: reference.nullable(), invitationId: uuid.nullable(), grantId: uuid.nullable(),
  reason: reason.nullable(), occurredAt: timestamp,
});
export const createdInvitationSchema: z.ZodType<CreatedInvitation> = z.strictObject({ invitation: invitationSummarySchema, created: z.boolean() });
export const adminManagementCapabilitiesSchema = z.strictObject({ canRevokeAdmins: z.boolean() });
export const revokedAdminGrantSchema = z.strictObject({ revoked: z.boolean() });

export const managementCursorPairSchema: z.ZodType<ManagementCursor> = z.strictObject({ occurredAt: timestamp, id: uuid });
const encodedCursor = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);

/** A cursor is validated data only. Preserve database timestamp precision and
 * reject alternate JSON/base64 spellings rather than interpolating SQL. */
export function parseManagementCursor(cursor: string | null): ManagementCursor | null {
  if (cursor === null) return null;
  try {
    const encoded = encodedCursor.parse(cursor);
    const decoded = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const pair = managementCursorPairSchema.parse(JSON.parse(decoded));
    const canonical = btoa(JSON.stringify({ occurredAt: pair.occurredAt, id: pair.id }))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    if (canonical !== encoded) throw new Error();
    return pair;
  } catch {
    throw new Error('Invalid management cursor');
  }
}
export const managementCursorSchema = encodedCursor.refine(value => {
  try { parseManagementCursor(value); return true; } catch { return false; }
}, 'Invalid management cursor');
export function pageSchema<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.strictObject({ items: z.array(item).max(MANAGEMENT_PAGE_SIZE), nextCursor: managementCursorSchema.nullable() });
}
export function managementResultSchema<T>(value: z.ZodType<T>): z.ZodType<ManagementResult<T>> {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({
      ok: z.literal(false),
      code: z.enum(['NOT_FOUND', 'FORBIDDEN', 'DUPLICATE', 'VERSION_CONFLICT', 'RATE_LIMITED', 'INVALID_TRANSITION']),
      version: version.optional(), attemptsRemaining: z.number().int().min(0).max(5).optional(),
    }),
  ]);
}

// HTTP bodies omit session identity and route IDs. Store inputs add only the
// server-generated hash/code and explicitly selected invitation/grant IDs.
export const createInvitationRequestSchema = z.strictObject({ requestId: uuid, label, reason: reason.nullable() });
export const claimInvitationRequestSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const approveInvitationRequestSchema = z.strictObject({ version, verificationCode });
export const closeInvitationRequestSchema = z.strictObject({ version, action: z.enum(['cancel', 'reject']), reason });
export const revokeAdminGrantRequestSchema = z.strictObject({ reason });
export const createInvitationInputSchema = createInvitationRequestSchema.extend({ tokenHash });
export const claimInvitationInputSchema = z.strictObject({ tokenHash, verificationCode });
export const approveInvitationInputSchema = approveInvitationRequestSchema.extend({ invitationId: uuid });
export const closeInvitationInputSchema = closeInvitationRequestSchema.extend({ invitationId: uuid });
export const revokeAdminGrantInputSchema = revokeAdminGrantRequestSchema.extend({ grantId: uuid });

export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;
export type ClaimInvitationInput = z.infer<typeof claimInvitationInputSchema>;
export type ApproveInvitationInput = z.infer<typeof approveInvitationInputSchema>;
export type CloseInvitationInput = z.infer<typeof closeInvitationInputSchema>;
export type RevokeAdminGrantInput = z.infer<typeof revokeAdminGrantInputSchema>;

/** Actors must come from verified server sessions; implementations repeat
 * authority checks and return business failures without rolling back audits. */
export interface AdminManagementStore {
  capabilities(actor: UUID): Promise<{ canRevokeAdmins: boolean }>;
  roster(actor: UUID, cursor: string | null): Promise<Page<AdminRosterEntry>>;
  invitations(actor: UUID, cursor: string | null): Promise<Page<InvitationSummary>>;
  history(actor: UUID, cursor: string | null): Promise<Page<ManagementAuditEntry>>;
  create(actor: UUID, input: CreateInvitationInput): Promise<ManagementResult<CreatedInvitation>>;
  claim(actor: UUID, input: ClaimInvitationInput): Promise<ManagementResult<OwnClaim>>;
  ownClaims(actor: UUID, cursor: string | null): Promise<Page<OwnClaim>>;
  approve(actor: UUID, input: ApproveInvitationInput): Promise<ManagementResult<InvitationSummary>>;
  close(actor: UUID, input: CloseInvitationInput): Promise<ManagementResult<InvitationSummary>>;
  revoke(actor: UUID, input: RevokeAdminGrantInput): Promise<ManagementResult<{ revoked: boolean }>>;
}
