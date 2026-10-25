import {
  handymanBmBindingDigest,
  type HandymanBmClearanceBinding,
} from '../../src/modules/handyman-dispatch/handyman-bm-clearance';

/** TEST ONLY. Never live BM issuer/authentication/revocation evidence. */
export function bmClearanceTestFact(
  binding: HandymanBmClearanceBinding, overrides: Record<string, unknown> = {},
) {
  return {
    decision: 'APPROVED', authority: 'BUILDING_MANAGEMENT',
    issuerId: 'INDEPENDENT-BM-TEST-DOUBLE',
    applicabilityReference: 'TEST-ONLY-REQUIRED-PERMIT-AND-ACCESS-POLICY',
    verificationReference: 'TEST-ONLY-NOT-LIVE-BM-PROOF',
    bindingDigest: handymanBmBindingDigest(binding), verifiedAt: new Date().toISOString(),
    validFrom: binding.visit.startAt, validUntil: binding.visit.endAt, ...overrides,
  };
}

/** Complete test-only binding shell for work-revision consumer unit assertions. */
export function bmBindingTestFixture(): HandymanBmClearanceBinding {
  const id = '00000000-0000-4000-8000-000000000001';
  const startAt = new Date(Date.now() - 60_000).toISOString();
  const endAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    protocol: 'HANDYMAN_BM_CLEARANCE_V1', clientId: id, tenantCompanyId: id,
    buildingId: id, executionScopeId: id, handymanRequestId: id,
    approvedQuotationVersionId: id, assignmentId: id, providerContextId: id, crewId: id,
    location: { spaceId: id, roomId: id, areaId: id, floorId: id },
    leadDesignationId: id, leadMembershipId: id, leadUserId: id,
    members: [{ membershipId: id, workerContextId: id, workforceProfileId: id, userId: id }],
    approvedVariations: [], visit: { id, startAt, endAt },
    localPermit: { id, permitType: 'UNIT', validFrom: startAt, validUntil: endAt },
    localAccess: { id, startAt, endAt },
  };
}
