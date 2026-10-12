export type ISODate = string;
export type UUID = string;
export type Service = 'oral_check' | 'scaling' | 'filling';
export type Status = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed' | 'no_show';
export type Intake = 'open' | 'paused' | 'closed';
export type Relationship = 'self' | 'parent' | 'guardian' | 'family';
export type PatientInput = { fullName: string; phone: string; age: number; address: string; relationship: Relationship; authorizationAcknowledged: true };
export type Patient = PatientInput & { id: UUID; ageCapturedOn: ISODate; version: number };
export type BookingInput = { patientId: UUID; patientVersion: number; service: Service; date: ISODate; ageConfirmed: number; authorizationAcknowledged: true };
export type Appointment = { id: UUID; reference: string; patientId: UUID; patient: PatientInput; service: Service; date: ISODate; status: Status; version: number; createdAt: string; approvedAt: string | null; cancelBefore: string };
export type Availability = { date: ISODate; state: 'available' | 'full' | 'closed' | 'paused' | 'ineligible' };
export type Session = { accountId: UUID; csrfToken: string; expiresAt: string; isAdmin: boolean };
export type Decision = 'approve' | 'reject' | 'complete' | 'no_show' | 'cancel';
export type ErrorCode = 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'FULL' | 'INELIGIBLE_DATE' | 'INTAKE_CLOSED' | 'DUPLICATE' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_TRANSITION' | 'CUTOFF_PASSED' | 'UNRESOLVED_BOOKINGS' | 'RATE_LIMITED' | 'UNAVAILABLE';
export type ApiError = { error: { code: ErrorCode; correlationId: string } };

/** Admin-only safe outbox summary; provider IDs and error details stay private. */
export type NotificationSummary = { kind: 'approval' | 'rejection' | 'reminder' | 'cancellation'; state: 'queued' | 'leased' | 'retry' | 'accepted' | 'suppressed' | 'failed'; attemptCount: number };
/** Admin-only anonymized per-recipient snapshot; identifiers never cross this boundary. */
export type AdminNotificationSummary = { recipientLabel: string; state: 'queued' | 'leased' | 'retry' | 'paused_quota' | 'accepted' | 'suppressed' | 'failed'; attemptCount: number; safeReason: string | null };
export type AdminAppointment = Appointment & { notificationAttempts: NotificationSummary[]; adminNotificationAttempts?: AdminNotificationSummary[] };
