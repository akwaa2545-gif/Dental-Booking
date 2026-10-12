import { describe, expect, it } from 'vitest';
import { reservationFixtureTarget } from '../support/reservation-postgres';

const approvedLocal = {
  TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/dental_test_reservations',
  TEST_RESERVATION_ADMIN_URL: 'postgres://dental_test_admin@127.0.0.1:5433/dental_test_reservations',
  ALLOW_DISPOSABLE_RESERVATION_FIXTURES: 'true',
};

// These cover an already-written safety guard, not a claimed behavioral TDD red.
// No Client is constructed and no database is contacted by these pure tests.
describe('disposable reservation fixture target gate', () => {
  it('accepts an explicitly approved administrator on exactly the same local test database', () => {
    expect(reservationFixtureTarget(approvedLocal)).toBe(approvedLocal.TEST_RESERVATION_ADMIN_URL);
  });

  it('treats an omitted PostgreSQL default port as the same endpoint', () => {
    expect(reservationFixtureTarget({
      ...approvedLocal,
      TEST_DATABASE_URL: 'postgresql://postgres@localhost/dental_test_reservations',
      TEST_RESERVATION_ADMIN_URL: 'postgresql://dental_test_admin@localhost:5432/dental_test_reservations',
    })).toBe('postgresql://dental_test_admin@localhost:5432/dental_test_reservations');
  });

  it('requires the primary database target as well as the administrator target', () => {
    expect(() => reservationFixtureTarget({ ...approvedLocal, TEST_DATABASE_URL: undefined })).toThrow('TEST_DATABASE_URL required');
  });

  it.each([undefined, 'false', 'TRUE', '1'])('rejects missing or inexact fixture approval %s', approval => {
    expect(() => reservationFixtureTarget({ ...approvedLocal, ALLOW_DISPOSABLE_RESERVATION_FIXTURES: approval })).toThrow('Explicit prior approval');
  });

  it.each([undefined, '', 'not a connection URL'])('requires an administrator URL %s', url => {
    expect(() => reservationFixtureTarget({ ...approvedLocal, TEST_RESERVATION_ADMIN_URL: url })).toThrow('TEST_RESERVATION_ADMIN_URL required');
  });

  it('refuses an otherwise authorized hosted staging project because this fixture requires a local superuser', () => {
    const ref = 'abcdefghijklmnopqrst';
    expect(() => reservationFixtureTarget({
      ...approvedLocal,
      TEST_DATABASE_URL: `postgres://postgres@db.${ref}.supabase.co/postgres`,
      TEST_RESERVATION_ADMIN_URL: `postgres://dental_test_admin@db.${ref}.supabase.co/postgres`,
      ALLOW_REMOTE_TEST_DATABASE: 'true',
      TEST_SUPABASE_PROJECT_REF: ref,
    })).toThrow('hosted targets are forbidden');
  });

  it.each([
    ['different host', 'postgres://dental_test_admin@localhost:5433/dental_test_reservations'],
    ['external host', 'postgres://dental_test_admin@example.org:5433/dental_test_reservations'],
    ['different port', 'postgres://dental_test_admin@127.0.0.1:5434/dental_test_reservations'],
    ['different database', 'postgres://dental_test_admin@127.0.0.1:5433/dental_test_another'],
    ['live database name', 'postgres://dental_test_admin@127.0.0.1:5433/postgres'],
    ['different user', 'postgres://postgres@127.0.0.1:5433/dental_test_reservations'],
    ['wrong protocol', 'https://dental_test_admin@127.0.0.1:5433/dental_test_reservations'],
    ['query override', 'postgres://dental_test_admin@127.0.0.1:5433/dental_test_reservations?host=example.org'],
    ['fragment', 'postgres://dental_test_admin@127.0.0.1:5433/dental_test_reservations#override'],
  ])('rejects administrator %s', (_case, url) => {
    expect(() => reservationFixtureTarget({ ...approvedLocal, TEST_RESERVATION_ADMIN_URL: url })).toThrow('exact approved disposable local database');
  });

  it('does not expose administrator connection secrets in validation errors', () => {
    let thrown: unknown;
    try {
      reservationFixtureTarget({ ...approvedLocal, TEST_RESERVATION_ADMIN_URL: 'postgres://unexpected:PRIVATE_SECRET_CANARY@127.0.0.1:5433/dental_test_reservations' });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain('PRIVATE_SECRET_CANARY');
  });
});
