import { describe, expect, it } from 'vitest';
import { parseBooking, parsePatient, requiresAgeReview } from '../../src/shared/validation';

const patient = { fullName: '  ผู้รับบริการสมมติ  ', phone: '0800000000', age: 35, address: '  ที่อยู่สมมติสำหรับทดสอบ  ', relationship: 'self', authorizationAcknowledged: true };
const booking = { patientId: '00000000-0000-4000-8000-000000000001', patientVersion: 1, service: 'oral_check', date: '2026-10-09', ageConfirmed: 35, authorizationAcknowledged: true };

describe('strict prototype patient validation', () => {
  it('trims required human fields while retaining the exact phone digits', () => {
    expect(parsePatient(patient)).toEqual({ ...patient, fullName: 'ผู้รับบริการสมมติ', phone: '0800000000', address: 'ที่อยู่สมมติสำหรับทดสอบ' });
  });
  it('rejects formatted and separator-only phones', () => {
    expect(() => parsePatient({ ...patient, phone: '(02) 123-4567' })).toThrow();
    expect(() => parsePatient({ ...patient, phone: '() -- .' })).toThrow();
  });
  it.each([-1, 35.5, 151, NaN, Infinity, '35'])('rejects invalid age %s', (age) => {
    expect(() => parsePatient({ ...patient, age })).toThrow();
    expect(() => parseBooking({ ...booking, ageConfirmed: age })).toThrow();
  });
  it('accepts ages 0 through 150 and flags over 120 for clinic review', () => {
    expect(parsePatient({ ...patient, age: 0 }).age).toBe(0);
    expect(parsePatient({ ...patient, age: 150 }).age).toBe(150);
    expect(requiresAgeReview(120)).toBe(false);
    expect(requiresAgeReview(121)).toBe(true);
  });
  it.each([
    { fullName: ' ' }, { fullName: 'ก'.repeat(121) },
    { phone: '123456' }, { phone: '0'.repeat(31) }, { phone: 'telephone' },
    { address: ' ' }, { address: 'ก'.repeat(501) },
    { relationship: 'stranger' }, { authorizationAcknowledged: false },
  ])('rejects a missing, excessive or unauthorized field %j', (override) => {
    expect(() => parsePatient({ ...patient, ...override })).toThrow();
  });
  it('accepts the exact name and address length limits with a ten-digit phone', () => {
    expect(parsePatient({ ...patient, fullName: 'ก'.repeat(120), phone: '0'.repeat(10), address: 'ก'.repeat(500) }).fullName).toHaveLength(120);
  });
  it('rejects unknown authority or identity fields instead of silently stripping them', () => {
    expect(() => parsePatient({ ...patient, accountId: 'other-account' })).toThrow();
    expect(() => parsePatient({ ...patient, nationalId: 'fictional' })).toThrow();
    expect(() => parseBooking({ ...booking, status: 'approved' })).toThrow();
  });
});

describe('strict booking validation', () => {
  it('accepts a profile version, real date, service and confirmed age', () => {
    expect(parseBooking(booking)).toEqual(booking);
  });
  it.each(['2026-02-30', '2026-02-29', '2026-13-01', '09/10/2026'])('rejects impossible or non-ISO date %s', (date) => {
    expect(() => parseBooking({ ...booking, date })).toThrow();
  });
  it.each([{ patientId: 'guess' }, { patientVersion: 0 }, { patientVersion: 1.5 }, { service: 'other' }, { authorizationAcknowledged: false }])('rejects malformed booking %j', (override) => {
    expect(() => parseBooking({ ...booking, ...override })).toThrow();
  });
});
