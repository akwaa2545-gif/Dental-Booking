import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { ManagementResult } from '../../src/shared/admin-management';
import type { AdminManagementFixture, ManagementIdentity } from './admin-management-postgres';
export const code = '00123456';
export const createInput = () => ({ requestId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), label: 'Synthetic colleague', reason: null });
export function value<T>(result: ManagementResult<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code); return result.value; }
export async function issued(f: AdminManagementFixture, issuer: ManagementIdentity) {
  const input = createInput(); const result = value(await f.store.create(issuer.account, input)); return { input, invitation: result.invitation };
}
export async function claimed(f: AdminManagementFixture, issuer: ManagementIdentity, recipient: string) {
  const item = await issued(f, issuer); const own = value(await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: code }));
  return { ...item, invitation: own.invitation, approve: { invitationId: own.invitation.id, version: own.invitation.version, verificationCode: code } };
}
export async function row(f: AdminManagementFixture, id: string) { return (await f.control.query('select * from dental.admin_invitations where id=$1', [id])).rows[0]; }
export async function audits(f: AdminManagementFixture, id: string) { return (await f.control.query('select action,result from dental.admin_management_audit where invitation_id=$1 order by occurred_at,id', [id])).rows; }
export async function grants(f: AdminManagementFixture, account: string) { return (await f.control.query('select * from dental.admin_grants where account_id=$1 order by granted_at,id', [account])).rows; }
export async function operatorGrant(f: AdminManagementFixture, operator: string, target: string, granted: boolean) {
  return f.operatorCall('select dental.set_admin_grant($1,$2,$3,$4) as result', [operator, target, granted, 'Synthetic lifecycle fixture']);
}
