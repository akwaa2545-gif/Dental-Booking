import type { Membership } from './managed-memberships';

export type Task8Membership = Membership & { grantor: string };
const expected: readonly Task8Membership[] = [
  { parent: 'dental_backend', member: 'dental_runtime', grantor: 'postgres', admin_option: false, inherit_option: true, set_option: false, grantor_super: false },
  ...['dental_backend', 'dental_function_owner', 'dental_runtime'].map(parent => ({
    parent, member: 'postgres', grantor: 'supabase_admin', admin_option: true,
    inherit_option: false, set_option: false, grantor_super: true,
  })),
];

/** Read-only assertion for the separately approved PG17 Task 8 role baseline.
 * Does not create roles, weaken older managed baselines, or authorize fixtures. */
export function assertTask8MembershipBaseline(version: number, rows: readonly Task8Membership[]): void {
  const exact = Math.floor(version / 10000) === 17 && rows.length === expected.length
    && expected.every(target => rows.filter(row => (
      row.parent === target.parent && row.member === target.member && row.grantor === target.grantor
      && row.admin_option === target.admin_option && row.inherit_option === target.inherit_option
      && row.set_option === target.set_option && row.grantor_super === target.grantor_super
    )).length === 1);
  if (!exact) throw new Error('Unexpected Task 8 runtime membership baseline');
}
