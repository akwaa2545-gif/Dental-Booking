import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertTask8MembershipBaseline, type Task8Membership } from '../support/task8-memberships';

const baseline: Task8Membership[] = [
  { parent: 'dental_backend', member: 'dental_runtime', grantor: 'postgres', admin_option: false, inherit_option: true, set_option: false, grantor_super: false },
  ...['dental_backend', 'dental_function_owner', 'dental_runtime'].map(parent => ({
    parent, member: 'postgres', grantor: 'supabase_admin', admin_option: true,
    inherit_option: false, set_option: false, grantor_super: true,
  })),
];
const mutations = baseline.flatMap((original, index) => Object.keys(original).map(key => {
  const field = key as keyof Task8Membership;
  const value = original[field];
  const changed = { ...original, [field]: typeof value === 'boolean' ? !value : `unreviewed_${value}` };
  return { label: `${index}:${field}`, rows: baseline.map((row, rowIndex) => rowIndex === index ? changed : row) };
}));

describe('Task 8 exact runtime membership assertion (local data only)', () => {
  it('accepts the four PG17 tuples including named grantors', () => {
    expect(() => assertTask8MembershipBaseline(170011, baseline)).not.toThrow();
    expect(() => assertTask8MembershipBaseline(170011, [...baseline].reverse())).not.toThrow();
  });
  it.each(mutations)('rejects drift in $label', ({ rows }) => {
    expect(() => assertTask8MembershipBaseline(170011, rows)).toThrow('Unexpected Task 8 runtime membership baseline');
  });
  it.each([[], baseline.slice(0, 3), [...baseline, baseline[0]], [baseline[0], baseline[0], baseline[2], baseline[3]]].map(rows => ({ rows })))('rejects missing, duplicated or extra tuples', ({ rows }) => {
    expect(() => assertTask8MembershipBaseline(170011, rows)).toThrow();
  });
  it.each([150019, 160000, 180000])('rejects unreviewed PostgreSQL version %i', version => {
    expect(() => assertTask8MembershipBaseline(version, baseline)).toThrow();
  });
  it('binds the helper test vector to the exact migration manifest', () => {
    const sql = readFileSync('db/migrations/006_notifications.sql', 'utf8');
    const manifest = sql.match(/v_expected_memberships jsonb := '([\s\S]*?)'::jsonb;/)?.[1];
    expect(JSON.parse(manifest ?? 'null')).toEqual(baseline.map(row => ({
      role: row.parent, member: row.member, grantor: row.grantor,
      admin: row.admin_option, inherit: row.inherit_option, set: row.set_option,
    })));
  });
  it('queries every incoming and outgoing runtime/private membership and named grantor in the real DB assertion', () => {
    const test = readFileSync('tests/db/schema.test.ts', 'utf8');
    expect(test).toContain('assertTask8MembershipBaseline(version,rows)');
    expect(test).toContain('grantor.rolname as grantor');
    expect(test.match(/(?:parent|member)\.rolname in \('dental_backend','dental_function_owner','dental_runtime'\)/g)).toHaveLength(2);
    expect(test).not.toContain('assertMembershipBaseline');
  });
});
