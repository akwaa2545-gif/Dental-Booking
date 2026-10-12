import { z } from 'zod';
import {
  adminManagementCapabilitiesSchema, adminRosterEntrySchema, approveInvitationRequestSchema,
  closeInvitationRequestSchema, createInvitationRequestSchema, invitationSummarySchema,
  managementAuditEntrySchema, managementCursorSchema, pageSchema, revokeAdminGrantRequestSchema,
  revokedAdminGrantSchema, type CreatedInvitation,
} from '../../shared/admin-management';
import { ApiRequestError, claimAdminInvitation, listOwnAdminClaims, type ApiClient } from '../api';

export type CreatedInvitationResponse = CreatedInvitation & { invitationUrl?: string };
const createdResponse = z.discriminatedUnion('created', [
  z.strictObject({ created: z.literal(true), invitation: invitationSummarySchema, invitationUrl: z.string().min(1).max(2048) }),
  z.strictObject({ created: z.literal(false), invitation: invitationSummarySchema }),
]);
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiRequestError('VALIDATION', 400);
  return parsed.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiRequestError('UNAVAILABLE', 503);
  return parsed.data;
}
/** Canonical app-only URL. Parsing alone would accept normalized paths or credentials. */
export function safeInvitationUrl(value: unknown, origin = window.location.origin): string | null {
  if (typeof value !== 'string') return null;
  try {
    const app = new URL(origin), url = new URL(value);
    const token = /^#invite=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1];
    if (app.protocol !== 'https:' || app.origin !== origin || url.protocol !== 'https:' || url.origin !== origin
      || url.username || url.password || url.pathname !== '/admin-invitation' || url.search || !token
      || value !== `${origin}/admin-invitation#invite=${token}`) return null;
    return value;
  } catch { return null; }
}
/** Direct Worker DTOs, strict bodies and route IDs. Identity is supplied by the bound session client. */
export function createManagementApi(api: ApiClient) {
  const root = '/api/admin/management';
  const get = async <T,>(path: string, schema: z.ZodType<T>, cursor: string | null = null) => {
    input(managementCursorSchema.nullable(), cursor);
    return output(schema, await api.request<unknown>(`${root}/${path}${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`));
  };
  const post = async <I, O>(path: string, schema: z.ZodType<I>, body: I, result: z.ZodType<O>) => {
    const fields = input(schema, body);
    return output(result, await api.request<unknown>(`${root}/${path}`, { method: 'POST', body: JSON.stringify(fields) }));
  };
  const routeId = (id: string) => input(z.uuid(), id);
  return {
    capabilities: () => get('capabilities', adminManagementCapabilitiesSchema),
    roster: (cursor: string | null = null) => get('roster', pageSchema(adminRosterEntrySchema), cursor),
    invitations: (cursor: string | null = null) => get('invitations', pageSchema(invitationSummarySchema), cursor),
    history: (cursor: string | null = null) => get('history', pageSchema(managementAuditEntrySchema), cursor),
    create: (body: z.infer<typeof createInvitationRequestSchema>): Promise<CreatedInvitationResponse> => post('invitations', createInvitationRequestSchema, body, createdResponse),
    approve: async (id: string, body: z.infer<typeof approveInvitationRequestSchema>) => post(`invitations/${routeId(id)}/approve`, approveInvitationRequestSchema, body, invitationSummarySchema),
    close: async (id: string, body: z.infer<typeof closeInvitationRequestSchema>) => post(`invitations/${routeId(id)}/close`, closeInvitationRequestSchema, body, invitationSummarySchema),
    revoke: async (id: string, body: z.infer<typeof revokeAdminGrantRequestSchema>) => post(`grants/${routeId(id)}/revoke`, revokeAdminGrantRequestSchema, body, revokedAdminGrantSchema),
    claim: (token: string) => claimAdminInvitation(api, token),
    ownClaims: (cursor: string | null = null) => listOwnAdminClaims(api, cursor),
  };
}
