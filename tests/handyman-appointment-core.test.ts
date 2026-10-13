import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateHandymanAppointmentAdmission,
  intervalsOverlap,
  isEligibleFinalInspectionAttempt,
  type HandymanAppointmentAdmissionFacts,
} from '../src/modules/handyman-appointment-contract/handyman-appointment-core.ts';

const slot = { startAt: '2026-10-19T09:00:00+07:00', endAt: '2026-10-19T10:00:00+07:00', timezone: 'Asia/Jakarta' };
function validFacts(): HandymanAppointmentAdmissionFacts {
  return {
    kind: 'INSPECTION', requestId: 'request-1', tenantId: 'tenant-1', buildingId: 'building-1',
    resourceId: 'inspector-1', resourceEligible: true, interval: { ...slot },
    choice: {
      requestId: 'request-1', tenantId: 'tenant-1', kind: 'INSPECTION',
      selectedStartAt: slot.startAt, selectedEndAt: slot.endAt,
      consentEvidenceId: 'trusted-consent-reference', verifiedByServer: true,
    },
    inspectionRequired: true, quotationApproved: false,
    permit: { policyEvaluated: true, required: false, satisfied: false },
    siteAccess: { policyEvaluated: true, required: false, satisfied: false },
    existingResourceBookings: [],
  };
}
const codes = (facts: HandymanAppointmentAdmissionFacts, phase: 'BOOKING' | 'VISIT_START' = 'BOOKING') => evaluateHandymanAppointmentAdmission(facts, phase).blockers;

test('01 onsite inspection appointment passes when all trusted facts are present', () => {
  assert.deepEqual(codes(validFacts()), []);
});
test('02 execution cannot use inspection consent or bypass quotation approval', () => {
  const f = validFacts(); f.kind = 'EXECUTION';
  assert.deepEqual(codes(f), ['QUOTATION_NOT_APPROVED', 'TENANT_CHOICE_MISMATCH']);
});
test('03 execution approval and independently verified execution slot can pass', () => {
  const f = validFacts(); f.kind = 'EXECUTION'; f.quotationApproved = true;
  f.choice = { ...f.choice!, kind: 'EXECUTION' };
  assert.deepEqual(codes(f), []);
});
test('04 non-onsite triage cannot be fabricated into an inspection visit', () => {
  const f = validFacts(); f.inspectionRequired = false;
  assert.ok(codes(f).includes('INSPECTION_NOT_REQUIRED'));
});
test('05 no verified tenant decision / missing consent proof denies confirmation', () => {
  const f = validFacts(); f.choice = { ...f.choice!, verifiedByServer: false };
  assert.ok(codes(f).includes('TENANT_CHOICE_NOT_VERIFIED'));
  f.choice = null;
  assert.ok(codes(f).includes('TENANT_CHOICE_NOT_VERIFIED'));
});
test('06 Care-selected different time, request, or represented tenant cannot confirm', () => {
  for (const change of [
    { selectedEndAt: '2026-10-19T11:00:00+07:00' },
    { requestId: 'other-request' },
    { tenantId: 'other-tenant' },
  ]) {
    const f = validFacts(); f.choice = { ...f.choice!, ...change };
    assert.ok(codes(f).includes('TENANT_CHOICE_MISMATCH'));
  }
});
test('07 all intervals must be valid ISO with timezone, and end after start', () => {
  const f = validFacts(); f.interval.startAt = '2026-10-19T09:00:00';
  assert.ok(codes(f).includes('INVALID_TIME_WINDOW'));
  f.interval.startAt = slot.endAt;
  assert.ok(codes(f).includes('INVALID_TIME_WINDOW'));
  f.interval = { ...slot, timezone: 'not-a-timezone' };
  assert.ok(codes(f).includes('INVALID_TIMEZONE'));
});
test('08 availability preflight blocks confirmed overlaps for same inspector', () => {
  const f = validFacts(); f.existingResourceBookings = [{
    ...slot, resourceId: 'inspector-1', appointmentId: 'visit-other', status: 'CONFIRMED',
  }];
  assert.ok(codes(f).includes('CAPACITY_CONFLICT'));
});
test('09 different resource or cancelled booking does not block capacity', () => {
  const f = validFacts(); f.existingResourceBookings = [
    { ...slot, resourceId: 'inspector-2', appointmentId: 'visit-other', status: 'CONFIRMED' },
    { ...slot, resourceId: 'inspector-1', appointmentId: 'visit-cancelled', status: 'CANCELLED' },
  ];
  assert.deepEqual(codes(f), []);
});
test('10 adjacent closed-open intervals do not overlap', () => {
  assert.equal(intervalsOverlap(slot, { startAt: slot.endAt, endAt: '2026-10-19T11:00:00+07:00' }), false);
});
test('11 no assumptions about permit and site access; fail closed on unresolved', () => {
  const f = validFacts(); f.permit.policyEvaluated = false; f.siteAccess.policyEvaluated = false;
  assert.deepEqual(codes(f, 'VISIT_START'), ['PERMIT_POLICY_UNRESOLVED', 'SITE_ACCESS_POLICY_UNRESOLVED']);
});
test('12 required permit and access block when unsatisfied', () => {
  const f = validFacts(); f.permit.required = true; f.siteAccess.required = true;
  assert.deepEqual(codes(f, 'VISIT_START'), ['PERMIT_NOT_READY', 'SITE_ACCESS_NOT_READY']);
});
test('13 ineligible inspector or crew cannot be booked', () => {
  const f = validFacts(); f.resourceEligible = false;
  assert.deepEqual(codes(f), ['INELIGIBLE_RESOURCE']);
});
test('14 no-show, aborted, inaccessible attempts never count as final inspection', () => {
  for (const outcome of ['NO_SHOW', 'ACCESS_BLOCKED', 'ABORTED', 'REBOOK_REQUIRED'] as const) {
    assert.equal(isEligibleFinalInspectionAttempt('INSPECTION', outcome, true), false);
  }
});
test('15 completed inspector visit still requires verified evidence', () => {
  assert.equal(isEligibleFinalInspectionAttempt('INSPECTION', 'COMPLETED', false), false);
  assert.equal(isEligibleFinalInspectionAttempt('EXECUTION', 'COMPLETED', true), false);
  assert.equal(isEligibleFinalInspectionAttempt('INSPECTION', 'COMPLETED', true), true);
});
test('16 a replay of the same booking must not conflict against itself', () => {
  const f = validFacts(); f.appointmentId = 'current-id';
  f.existingResourceBookings = [{ ...slot, appointmentId: 'current-id', resourceId: f.resourceId, status: 'CONFIRMED' }];
  assert.deepEqual(codes(f), []);
});

test('17 missing Security clearance does not by itself prevent confirming a future appointment', () => {
  const f = validFacts(); f.permit.required = true; f.siteAccess.required = true;
  assert.deepEqual(codes(f, 'BOOKING'), []);
  assert.deepEqual(codes(f, 'VISIT_START'), ['PERMIT_NOT_READY', 'SITE_ACCESS_NOT_READY']);
});

test('18 invalid appointment kind from unsafe transport is refused', () => {
  const f = validFacts(); f.kind = 'UNKNOWN' as never;
  assert.ok(codes(f).includes('INVALID_APPOINTMENT_KIND'));
});
test('19 absent effective permit/access facts cannot start a visit', () => {
  const f = validFacts(); f.permit = undefined as never; f.siteAccess = undefined as never;
  assert.deepEqual(codes(f, 'VISIT_START'), ['PERMIT_POLICY_UNRESOLVED', 'SITE_ACCESS_POLICY_UNRESOLVED']);
});
