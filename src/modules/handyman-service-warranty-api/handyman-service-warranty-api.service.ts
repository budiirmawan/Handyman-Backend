/**
 * CR-HM-17 GAP PART 06 — Customer Care HTTP/OpenAPI service transport over
 * `CR-HM-15` Service Warranty, Claim, Free Rework & Chargeable Additional Work
 * (`docs/handyman/CR-HM-17_CUSTOMER_CARE_TRANSPORT_GAP_GOVERNANCE.md` §4.6,
 * `BLK-05`).
 *
 * Strictly thin transport:
 *   - Wraps the 5 published `CR-HM-15 PART 05` contract readers with
 *     `contextAccessService.canAccessClient(actorUserId, contract.warranty.clientId)`
 *   - Wraps only governed customer-side claim and decision commands (`open`,
 *     `submit`, `approve`, `reject`, `withdraw` claim; `authorize` free rework;
 *     `accept` / `reject` chargeable additional work)
 *   - Never exposes field-worker rework execution (`propose`, `start`,
 *     `complete`, `verify`) or warranty lifecycle calculation (`start`, `expire`)
 *   - Preserves `Asset Warranty != Handyman Service Warranty` and
 *     `Free Warranty Rework != Chargeable Additional Work` and enforces the
 *     no-pricing / no-ledger / no-settlement / no-asset-warranty firewall.
 */

import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  assertHandymanServiceWarrantyContractShape,
  HandymanServiceWarrantyContract,
  readHandymanChargeableAdditionalWorkContract,
  readHandymanServiceWarrantyClaimContract,
  readHandymanServiceWarrantyContractByExecutionScopeId,
  readHandymanServiceWarrantyContractByWarrantyId,
  readHandymanServiceWarrantyReworkContract,
} from '../handyman-service-warranty-contracts';
import {
  handymanServiceWarrantyNotAuthorizedError,
  handymanServiceWarrantyValidationError,
} from '../handyman-service-warranties';
import {
  approveHandymanServiceWarrantyClaim,
  handymanServiceWarrantyClaimNotAuthorizedError,
  handymanServiceWarrantyClaimValidationError,
  HandymanServiceWarrantyClaimCommandResult,
  openHandymanServiceWarrantyClaim,
  rejectHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
  withdrawHandymanServiceWarrantyClaim,
} from '../handyman-service-warranty-claims';
import {
  authorizeHandymanServiceWarrantyRework,
  handymanServiceWarrantyReworkNotAuthorizedError,
  handymanServiceWarrantyReworkValidationError,
  HandymanServiceWarrantyReworkCommandResult,
} from '../handyman-service-warranty-reworks';
import {
  acceptHandymanChargeableAdditionalWork,
  handymanChargeableAdditionalWorkNotAuthorizedError,
  handymanChargeableAdditionalWorkValidationError,
  HandymanChargeableAdditionalWorkCommandResult,
  rejectHandymanChargeableAdditionalWork,
} from '../handyman-chargeable-additional-works';

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function serializeContract(contract: HandymanServiceWarrantyContract) {
  const view = {
    contractVersion: contract.contractVersion,
    contractSource: contract.contractSource,
    readOnly: contract.readOnly,
    warranty: {
      id: contract.warranty.id,
      clientId: contract.warranty.clientId,
      executionScopeId: contract.warranty.executionScopeId,
      bastId: contract.warranty.bastId,
      status: contract.warranty.status,
      startsAt: contract.warranty.startsAt.toISOString(),
      bastAcceptedAt: contract.warranty.bastAcceptedAt.toISOString(),
      expiredAt: toIso(contract.warranty.expiredAt),
      coverages: contract.warranty.coverages.map((coverage) => ({
        coverageType: coverage.coverageType,
        coverageSince: coverage.coverageSince.toISOString(),
      })),
    },
    claims: contract.claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      evidenceRecordId: claim.evidenceRecordId,
      claimNote: claim.claimNote,
      submittedAt: toIso(claim.submittedAt),
      decidedAt: toIso(claim.decidedAt),
      decisionNote: claim.decisionNote,
      withdrawnAt: toIso(claim.withdrawnAt),
      createdAt: claim.createdAt.toISOString(),
      reworkId: claim.reworkId,
      chargeableAdditionalWorkId: claim.chargeableAdditionalWorkId,
    })),
    reworks: contract.reworks.map((rework) => ({
      id: rework.id,
      claimId: rework.claimId,
      status: rework.status,
      scopeNote: rework.scopeNote,
      proposedAt: rework.proposedAt.toISOString(),
      authorizedAt: toIso(rework.authorizedAt),
      startedAt: toIso(rework.startedAt),
      completedAt: toIso(rework.completedAt),
      verifiedAt: toIso(rework.verifiedAt),
      verificationEvidenceRecordId: rework.verificationEvidenceRecordId,
      verificationQcRunId: rework.verificationQcRunId,
    })),
    chargeableAdditionalWorks: contract.chargeableAdditionalWorks.map(
      (work) => ({
        id: work.id,
        claimId: work.claimId,
        status: work.status,
        scopeNote: work.scopeNote,
        proposedAt: work.proposedAt.toISOString(),
        decidedAt: toIso(work.decidedAt),
        paymentTriggerEmittedAt: toIso(work.paymentTriggerEmittedAt),
      }),
    ),
    anchors: { ...contract.anchors },
    history: {
      bastAcceptedAt: contract.history.bastAcceptedAt.toISOString(),
      warrantyStartsAt: contract.history.warrantyStartsAt.toISOString(),
      warrantyExpiredAt: toIso(contract.history.warrantyExpiredAt),
      claimSubmittedAt: toIso(contract.history.claimSubmittedAt),
      claimDecidedAt: toIso(contract.history.claimDecidedAt),
      reworkCompletedAt: toIso(contract.history.reworkCompletedAt),
      reworkVerifiedAt: toIso(contract.history.reworkVerifiedAt),
      chargeableDecidedAt: toIso(contract.history.chargeableDecidedAt),
      paymentTriggerEmittedAt: toIso(contract.history.paymentTriggerEmittedAt),
    },
    lifecycle: { ...contract.lifecycle },
    readiness: { ...contract.readiness },
  };
  assertHandymanServiceWarrantyContractShape(view);
  return view;
}

export type HandymanServiceWarrantyContractView = ReturnType<
  typeof serializeContract
>;

function serializeClaimCommandResult(
  result: HandymanServiceWarrantyClaimCommandResult,
) {
  const view = {
    claim: {
      id: result.claim.id,
      clientId: result.claim.clientId,
      executionScopeId: result.claim.executionScopeId,
      bastId: result.claim.bastId,
      warrantyId: result.claim.warrantyId,
      status: result.claim.status,
      claimNote: result.claim.claimNote,
      evidenceRecordId: result.claim.evidenceRecordId,
      openedByUserId: result.claim.openedByUserId,
      submittedAt: toIso(result.claim.submittedAt),
      claimantUserId: result.claim.claimantUserId,
      decidedAt: toIso(result.claim.decidedAt),
      decidedByUserId: result.claim.decidedByUserId,
      decisionNote: result.claim.decisionNote,
      withdrawnAt: toIso(result.claim.withdrawnAt),
      createdAt: result.claim.createdAt.toISOString(),
      updatedAt: result.claim.updatedAt.toISOString(),
    },
    event: {
      id: result.event.id,
      clientId: result.event.clientId,
      claimId: result.event.claimId,
      warrantyId: result.event.warrantyId,
      executionScopeId: result.event.executionScopeId,
      bastId: result.event.bastId,
      eventType: result.event.eventType,
      idempotencyKey: result.event.idempotencyKey,
      actorUserId: result.event.actorUserId,
      occurredAt: result.event.occurredAt.toISOString(),
      createdAt: result.event.createdAt.toISOString(),
    },
    warrantyStatus: result.warrantyStatus,
    replayed: result.replayed,
  };
  assertHandymanServiceWarrantyContractShape(view);
  return view;
}

function serializeReworkCommandResult(
  result: HandymanServiceWarrantyReworkCommandResult,
) {
  const view = {
    rework: {
      id: result.rework.id,
      clientId: result.rework.clientId,
      executionScopeId: result.rework.executionScopeId,
      bastId: result.rework.bastId,
      warrantyId: result.rework.warrantyId,
      claimId: result.rework.claimId,
      status: result.rework.status,
      scopeNote: result.rework.scopeNote,
      proposedAt: result.rework.proposedAt.toISOString(),
      proposedByUserId: result.rework.proposedByUserId,
      authorizedAt: toIso(result.rework.authorizedAt),
      authorizedByUserId: result.rework.authorizedByUserId,
      startedAt: toIso(result.rework.startedAt),
      completedAt: toIso(result.rework.completedAt),
      completionNote: result.rework.completionNote,
      verifiedAt: toIso(result.rework.verifiedAt),
      verifiedByUserId: result.rework.verifiedByUserId,
      verificationEvidenceRecordId: result.rework.verificationEvidenceRecordId,
      verificationQcRunId: result.rework.verificationQcRunId,
      createdAt: result.rework.createdAt.toISOString(),
      updatedAt: result.rework.updatedAt.toISOString(),
    },
    event: {
      id: result.event.id,
      clientId: result.event.clientId,
      reworkId: result.event.reworkId,
      claimId: result.event.claimId,
      warrantyId: result.event.warrantyId,
      executionScopeId: result.event.executionScopeId,
      bastId: result.event.bastId,
      eventType: result.event.eventType,
      idempotencyKey: result.event.idempotencyKey,
      actorUserId: result.event.actorUserId,
      occurredAt: result.event.occurredAt.toISOString(),
      createdAt: result.event.createdAt.toISOString(),
    },
    warrantyStatus: result.warrantyStatus,
    claimStatus: result.claimStatus,
    replayed: result.replayed,
  };
  assertHandymanServiceWarrantyContractShape(view);
  return view;
}

function serializeChargeableWorkEvent(
  event: HandymanChargeableAdditionalWorkCommandResult['event'],
) {
  return {
    id: event.id,
    clientId: event.clientId,
    workId: event.workId,
    claimId: event.claimId,
    warrantyId: event.warrantyId,
    executionScopeId: event.executionScopeId,
    bastId: event.bastId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    actorUserId: event.actorUserId,
    occurredAt: event.occurredAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  };
}

function serializeChargeableWorkCommandResult(
  result: HandymanChargeableAdditionalWorkCommandResult,
) {
  const view = {
    work: {
      id: result.work.id,
      clientId: result.work.clientId,
      executionScopeId: result.work.executionScopeId,
      bastId: result.work.bastId,
      warrantyId: result.work.warrantyId,
      claimId: result.work.claimId,
      status: result.work.status,
      scopeNote: result.work.scopeNote,
      proposedAt: result.work.proposedAt.toISOString(),
      proposedByUserId: result.work.proposedByUserId,
      decidedAt: toIso(result.work.decidedAt),
      decidedByUserId: result.work.decidedByUserId,
      paymentTriggerEmittedAt: toIso(result.work.paymentTriggerEmittedAt),
      createdAt: result.work.createdAt.toISOString(),
      updatedAt: result.work.updatedAt.toISOString(),
    },
    event: serializeChargeableWorkEvent(result.event),
    paymentTrigger: result.paymentTrigger
      ? serializeChargeableWorkEvent(result.paymentTrigger)
      : null,
    warrantyStatus: result.warrantyStatus,
    claimStatus: result.claimStatus,
    replayed: result.replayed,
  };
  assertHandymanServiceWarrantyContractShape(view);
  return view;
}

function requirePlainBody(
  body: unknown,
  onInvalid: (reason: string) => Error,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw onInvalid('body');
  }
  assertHandymanServiceWarrantyContractShape(body);
  return body as Record<string, unknown>;
}

/**
 * GET /handyman/execution-scopes/:executionScopeId/service-warranty
 */
export async function readExecutionScopeServiceWarrantyView(
  actorUserId: string,
  executionScopeId: string,
): Promise<HandymanServiceWarrantyContractView> {
  if (!isValidUuid(actorUserId)) {
    throw handymanServiceWarrantyValidationError('actorUserId');
  }
  if (!isValidUuid(executionScopeId)) {
    throw handymanServiceWarrantyValidationError('executionScopeId');
  }
  const contract =
    await readHandymanServiceWarrantyContractByExecutionScopeId(
      executionScopeId,
    );
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      contract.warranty.clientId,
    ))
  ) {
    throw handymanServiceWarrantyNotAuthorizedError();
  }
  return serializeContract(contract);
}

/**
 * GET /handyman/service-warranties/:warrantyId
 */
export async function readServiceWarrantyByIdView(
  actorUserId: string,
  warrantyId: string,
): Promise<HandymanServiceWarrantyContractView> {
  if (!isValidUuid(actorUserId)) {
    throw handymanServiceWarrantyValidationError('actorUserId');
  }
  if (!isValidUuid(warrantyId)) {
    throw handymanServiceWarrantyValidationError('warrantyId');
  }
  const contract =
    await readHandymanServiceWarrantyContractByWarrantyId(warrantyId);
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      contract.warranty.clientId,
    ))
  ) {
    throw handymanServiceWarrantyNotAuthorizedError();
  }
  return serializeContract(contract);
}

/**
 * GET /handyman/service-warranty-claims/:claimId
 */
export async function readServiceWarrantyClaimByIdView(
  actorUserId: string,
  claimId: string,
): Promise<HandymanServiceWarrantyContractView> {
  if (!isValidUuid(actorUserId)) {
    throw handymanServiceWarrantyClaimValidationError('actorUserId');
  }
  if (!isValidUuid(claimId)) {
    throw handymanServiceWarrantyClaimValidationError('claimId');
  }
  const contract = await readHandymanServiceWarrantyClaimContract(claimId);
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      contract.warranty.clientId,
    ))
  ) {
    throw handymanServiceWarrantyClaimNotAuthorizedError();
  }
  return serializeContract(contract);
}

/**
 * GET /handyman/service-warranty-reworks/:reworkId
 */
export async function readServiceWarrantyReworkByIdView(
  actorUserId: string,
  reworkId: string,
): Promise<HandymanServiceWarrantyContractView> {
  if (!isValidUuid(actorUserId)) {
    throw handymanServiceWarrantyReworkValidationError('actorUserId');
  }
  if (!isValidUuid(reworkId)) {
    throw handymanServiceWarrantyReworkValidationError('reworkId');
  }
  const contract = await readHandymanServiceWarrantyReworkContract(reworkId);
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      contract.warranty.clientId,
    ))
  ) {
    throw handymanServiceWarrantyReworkNotAuthorizedError();
  }
  return serializeContract(contract);
}

/**
 * GET /handyman/chargeable-additional-works/:workId
 */
export async function readChargeableAdditionalWorkByIdView(
  actorUserId: string,
  workId: string,
): Promise<HandymanServiceWarrantyContractView> {
  if (!isValidUuid(actorUserId)) {
    throw handymanChargeableAdditionalWorkValidationError('actorUserId');
  }
  if (!isValidUuid(workId)) {
    throw handymanChargeableAdditionalWorkValidationError('workId');
  }
  const contract = await readHandymanChargeableAdditionalWorkContract(workId);
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      contract.warranty.clientId,
    ))
  ) {
    throw handymanChargeableAdditionalWorkNotAuthorizedError();
  }
  return serializeContract(contract);
}

/**
 * POST /handyman/service-warranties/:warrantyId/claims
 */
export async function openCustomerServiceWarrantyClaim(
  actorUserId: string,
  warrantyId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyClaimValidationError,
  );
  const result = await openHandymanServiceWarrantyClaim(actorUserId, {
    warrantyId,
    idempotencyKey: payload.idempotencyKey as string,
    claimNote: payload.claimNote as string | null | undefined,
    evidenceRecordId: payload.evidenceRecordId as string | null | undefined,
  });
  return serializeClaimCommandResult(result);
}

/**
 * POST /handyman/service-warranty-claims/:claimId/submit
 */
export async function submitCustomerServiceWarrantyClaim(
  actorUserId: string,
  claimId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyClaimValidationError,
  );
  const result = await submitHandymanServiceWarrantyClaim(actorUserId, {
    claimId,
    idempotencyKey: payload.idempotencyKey as string,
    evidenceRecordId: payload.evidenceRecordId as string | null | undefined,
  });
  return serializeClaimCommandResult(result);
}

/**
 * POST /handyman/service-warranty-claims/:claimId/approve
 */
export async function approveCustomerServiceWarrantyClaim(
  actorUserId: string,
  claimId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyClaimValidationError,
  );
  const result = await approveHandymanServiceWarrantyClaim(actorUserId, {
    claimId,
    idempotencyKey: payload.idempotencyKey as string,
    decisionNote: payload.decisionNote as string | null | undefined,
  });
  return serializeClaimCommandResult(result);
}

/**
 * POST /handyman/service-warranty-claims/:claimId/reject
 */
export async function rejectCustomerServiceWarrantyClaim(
  actorUserId: string,
  claimId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyClaimValidationError,
  );
  const result = await rejectHandymanServiceWarrantyClaim(actorUserId, {
    claimId,
    idempotencyKey: payload.idempotencyKey as string,
    decisionNote: payload.decisionNote as string | null | undefined,
  });
  return serializeClaimCommandResult(result);
}

/**
 * POST /handyman/service-warranty-claims/:claimId/withdraw
 */
export async function withdrawCustomerServiceWarrantyClaim(
  actorUserId: string,
  claimId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyClaimValidationError,
  );
  const result = await withdrawHandymanServiceWarrantyClaim(actorUserId, {
    claimId,
    idempotencyKey: payload.idempotencyKey as string,
  });
  return serializeClaimCommandResult(result);
}

/**
 * POST /handyman/service-warranty-reworks/:reworkId/authorize
 */
export async function authorizeCustomerServiceWarrantyRework(
  actorUserId: string,
  reworkId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanServiceWarrantyReworkValidationError,
  );
  const result = await authorizeHandymanServiceWarrantyRework(actorUserId, {
    reworkId,
    idempotencyKey: payload.idempotencyKey as string,
  });
  return serializeReworkCommandResult(result);
}

/**
 * POST /handyman/chargeable-additional-works/:workId/accept
 */
export async function acceptCustomerChargeableAdditionalWork(
  actorUserId: string,
  workId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanChargeableAdditionalWorkValidationError,
  );
  const result = await acceptHandymanChargeableAdditionalWork(actorUserId, {
    workId,
    idempotencyKey: payload.idempotencyKey as string,
  });
  return serializeChargeableWorkCommandResult(result);
}

/**
 * POST /handyman/chargeable-additional-works/:workId/reject
 */
export async function rejectCustomerChargeableAdditionalWork(
  actorUserId: string,
  workId: string,
  body: unknown,
) {
  const payload = requirePlainBody(
    body,
    handymanChargeableAdditionalWorkValidationError,
  );
  const result = await rejectHandymanChargeableAdditionalWork(actorUserId, {
    workId,
    idempotencyKey: payload.idempotencyKey as string,
  });
  return serializeChargeableWorkCommandResult(result);
}
