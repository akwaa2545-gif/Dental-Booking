import { z } from 'zod';
import type { BookingInput, PatientInput } from './contracts';
import { isISODate } from './calendar';

// Prototype defaults for review, not a claim about clinic policy.
const age = z.number().int().min(0).max(150);
const patientSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().length(10).regex(/^[0-9]{10}$/),
  age,
  address: z.string().trim().min(1).max(500),
  relationship: z.enum(['self', 'parent', 'guardian', 'family']),
  authorizationAcknowledged: z.literal(true),
}).strict();

const bookingSchema = z.object({
  patientId: z.uuid(),
  patientVersion: z.number().int().min(1),
  service: z.enum(['oral_check', 'scaling', 'filling']),
  date: z.string().refine(isISODate, 'A real YYYY-MM-DD date is required'),
  ageConfirmed: age,
  authorizationAcknowledged: z.literal(true),
}).strict();

export function parsePatient(input: unknown): PatientInput {
  return patientSchema.parse(input);
}

export function parseBooking(input: unknown): BookingInput {
  return bookingSchema.parse(input);
}

/** Exceptional ages remain valid but need explicit clinic review in the UI. */
export function requiresAgeReview(value: number): boolean {
  return value > 120;
}
