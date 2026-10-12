import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('database suite prerequisite guard', () => {
  it('fails clearly without an approved database URL instead of requiring psql or reporting success', () => {
    const result = spawnSync(process.execPath, ['scripts/test-db.mjs'], { cwd: process.cwd(), env: { ...process.env, PATH: '/nonexistent', TEST_DATABASE_URL: '' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PostgreSQL');
    expect(result.stderr).toContain('TEST_DATABASE_URL required');
    expect(result.stderr).toContain('no PostgreSQL tests ran');
  });
});
