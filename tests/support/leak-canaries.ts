/** Distinct fictional markers. Never import this module into a production bundle. */
export const privateCanaries = {
 fullName:'CANARY_PERSON_7f0238', phone:'0987654321', age:117,
 address:'CANARY_ADDRESS_7f0238', relationship:'CANARY_RELATIONSHIP_7f0238',
 lineSubject:'U7f023809490e7f023809490e7f02380949',
 accountId:'7f023809-490e-4000-8000-000000000001',
 patientId:'7f023809-490e-4000-8000-000000000002',
 reason:'CANARY_REASON_7f0238', idToken:'CANARY_ID_TOKEN_7f0238',
 sessionToken:'CANARY_SESSION_7f0238', csrfToken:'CANARY_CSRF_7f0238',
} as const;
// Small numeric/enumerated values cannot be distinctive text canaries. Their
// exclusion is proved by response field allowlists, not false-positive scans.
export const personalDataCanaries=Object.values(privateCanaries).filter((value):value is Exclude<typeof value,number>=>typeof value==='string');
export function leakedCanaries(value:unknown):string[]{const text=typeof value==='string'?value:JSON.stringify(value);return personalDataCanaries.filter(canary=>text.includes(canary));}
