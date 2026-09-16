import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { isValidUuid } from '../clients';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
  handymanRequestStatusInvalidError,
} from '../handyman-requests';
import { handymanRequestTriageRepository } from '../handyman-request-governance';
import { recordOperationalEvent } from '../operational-events';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import {
  handymanQuotationApprovalForInvalidError,
  handymanQuotationApprovalNotFoundError,
  handymanQuotationApprovalNotAuthorizedError,
  handymanQuotationApprovalNotesRequiredError,
  handymanQuotationApprovalStateInvalidError,
  handymanQuotationApprovalNotPendingError,
} from './handyman-quotation-approval.errors';
import { handymanQuotationApprovalRepository } from './handyman-quotation-approval.repository';
import type { ApprovalDecisionFields } from './handyman-quotation-approval.repository';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import {
  loadQuotationOrThrow,
  toPublicHandymanQuotation,
} from './handyman-quotation.service';
import type {
  DecideHandymanQuotationApprovalInAppInput,
  HandymanQuotationApprovalDecision,
  HandymanQuotationApprovalDecisionResult,
  HandymanQuotationApprovalRecord,
  PublicHandymanQuotationApproval,
  RecordHandymanQuotationApprovalAssistedInput,
} from './handyman-quotation-approval.types';
import type { HandymanQuotationRecord } from './handyman-quotation.types';
import type { HandymanRequestRecord } from '../handyman-requests';

/**
 * CR-HM-BE-03 RUN 3 — Customer approval decision authority.
 *
 * Two governed decision channels, both authenticated, both once-only:
 *
 * - IN_APP: the actor (from the authenticated session parameter ONLY) must
 *   resolve to the tenant PIC authorized for the request through the
 *   governed tenant foundation links (tenant_pics.user_id → request's
 *   tenantPicId → request's tenantCompanyId → ACTIVE company under the same
 *   client → ACTIVE effective tenant building context). No role-name
 *   inference, no frontend/session shortcuts, and the caller can never
 *   submit approvedFor/recordedBy authority fields. recorded_by stays NULL —
 *   the decision is genuinely made directly by the authorized tenant PIC.
 *
 * - ASSISTED: an authenticated staff actor (governed building access; the
 *   `handyman_quotation_approval.record` permission is seeded for the Run-4
 *   HTTP RBAC wiring) records an out-of-band tenant/customer decision. The
 *   approved-for party MUST be explicitly identified and MUST belong to the
 *   request context; decision notes are mandatory; the actor is preserved
 *   SEPARATELY as recorded_by and never silently becomes the approved-for.
 *
 * Downstream transitions (identical for both channels) are guarded and
 * atomic in one transaction: APPROVED → quotation APPROVED + request
 * APPROVED; REJECTED → quotation REJECTED + request QUOTATION_REJECTED.
 *
 * SECURE_LINK is unreachable here by construction: no function in this
 * runtime accepts it, and the migration-0352 decided-state CHECK admits
 * IN_APP/ASSISTED only.
 */

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  return (
    (record.effectiveFrom === null || record.effectiveFrom.getTime() <= now) &&
    (record.effectiveUntil === null || record.effectiveUntil.getTime() >= now)
  );
}

function normalizeDecisionNotes(
  value: unknown,
  options: { required: boolean },
): string | null {
  if (value === undefined || value === null) {
    if (options.required) throw handymanQuotationApprovalNotesRequiredError();
    return null;
  }
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (options.required) throw handymanQuotationApprovalNotesRequiredError();
    return null;
  }
  if (trimmed.length > 2000) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be at most 2000 characters.' },
    ]);
  }
  return trimmed;
}

export function toPublicHandymanQuotationApproval(
  record: HandymanQuotationApprovalRecord,
): PublicHandymanQuotationApproval {
  return {
    id: record.id,
    quotationId: record.quotationId,
    quotationRevisionId: record.quotationRevisionId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    status: record.status,
    method: record.method,
    approvedForType: record.approvedForType,
    approvedForTenantCompanyId: record.approvedForTenantCompanyId,
    approvedForTenantPicId: record.approvedForTenantPicId,
    approvedForName: record.approvedForName,
    approvedForCustomerName: record.approvedForCustomerName,
    approvedForCustomerPhone: record.approvedForCustomerPhone,
    approvedForCustomerEmail: record.approvedForCustomerEmail,
    decisionNotes: record.decisionNotes,
    recordedByUserId: record.recordedByUserId,
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type DecidableContext = {
  quotation: HandymanQuotationRecord;
  approval: HandymanQuotationApprovalRecord;
  request: HandymanRequestRecord;
};

/**
 * Shared decidable-state gate: quotation SENT, its PENDING approval for the
 * EXACT sent revision (locked), request QUOTATION_PENDING. The lock makes
 * concurrent decide races (IN_APP vs IN_APP, ASSISTED vs IN_APP) serialize
 * on the approval row; the guarded updates then admit exactly one winner.
 */
async function loadDecidableContext(
  quotationId: string,
  tx: Pick<PoolClient, 'query'>,
): Promise<DecidableContext> {
  if (!isValidUuid(quotationId)) {
    throw handymanQuotationApprovalStateInvalidError(
      'quotationId must be a valid identifier.',
    );
  }
  const quotation = await handymanQuotationRepository.lockById(quotationId, tx);
  if (!quotation) throw handymanQuotationApprovalStateInvalidError(
    'Handyman quotation not found.',
  );
  if (quotation.status !== 'SENT') {
    throw handymanQuotationApprovalStateInvalidError(
      'Approval decisions require a SENT quotation.',
    );
  }
  if (!quotation.sentRevisionId) {
    throw handymanQuotationApprovalStateInvalidError(
      'A SENT quotation must bind its sent revision.',
    );
  }

  const approval = await handymanQuotationApprovalRepository.lockPendingByRevision(
    quotation.sentRevisionId,
    tx,
  );
  if (!approval) {
    const history = await handymanQuotationApprovalRepository.listByRevision(
      quotation.sentRevisionId,
      tx,
    );
    // Decide-once: a decided/expired approval is never re-decidable.
    if (history.length > 0) throw handymanQuotationApprovalNotPendingError();
    throw handymanQuotationApprovalNotFoundError();
  }

  const request = await handymanRequestRepository.findById(quotation.requestId, tx);
  if (!request) throw handymanRequestNotFoundError();
  if (request.status !== 'QUOTATION_PENDING') {
    throw handymanQuotationApprovalStateInvalidError(
      'Approval decisions require the handyman request to be QUOTATION_PENDING.',
    );
  }

  return { quotation, approval, request };
}

/**
 * IN_APP authorization: the actor resolves to the tenant PIC authorized for
 * the request through governed foundation links only — never through
 * role names or caller-supplied identity fields.
 */
async function resolveAuthorizedTenantPic(
  request: HandymanRequestRecord,
  actorUserId: string,
): Promise<{ picId: string; picName: string; companyId: string; companyName: string }> {
  if (!request.tenantPicId || !request.tenantCompanyId) {
    throw handymanQuotationApprovalNotAuthorizedError(
      'This request has no authorized tenant PIC; an IN_APP decision is not available.',
    );
  }
  const pic = await tenantPicRepository.findById(request.tenantPicId);
  if (!pic || pic.status !== 'ACTIVE' || pic.userId !== actorUserId) {
    throw handymanQuotationApprovalNotAuthorizedError();
  }
  if (pic.tenantCompanyId !== request.tenantCompanyId) {
    throw handymanQuotationApprovalNotAuthorizedError(
      'The tenant PIC is not linked to the tenant company of this request.',
    );
  }
  const company = await tenantCompanyRepository.findById(pic.tenantCompanyId);
  if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
    throw handymanQuotationApprovalNotAuthorizedError(
      'The tenant company of this request is not an ACTIVE company of this client.',
    );
  }
  const buildingContext = await tenantBuildingContextRepository.findActive(
    company.id,
    request.buildingId,
  );
  if (!buildingContext || !isEffectiveNow(buildingContext)) {
    throw handymanQuotationApprovalNotAuthorizedError(
      'The tenant company has no ACTIVE effective building context for this request.',
    );
  }
  return {
    picId: pic.id,
    picName: pic.picName,
    companyId: company.id,
    companyName: company.tenantName,
  };
}

/** ASSISTED approved-for validation against the request context. */
async function resolveApprovedFor(
  input: RecordHandymanQuotationApprovalAssistedInput['approvedFor'],
  request: HandymanRequestRecord,
): Promise<
  Pick<
    ApprovalDecisionFields,
    | 'approvedForType'
    | 'approvedForTenantCompanyId'
    | 'approvedForTenantPicId'
    | 'approvedForName'
    | 'approvedForCustomerName'
    | 'approvedForCustomerPhone'
    | 'approvedForCustomerEmail'
  >
> {
  if (input.type === 'CUSTOMER') {
    // The customer snapshot comes from the request — never from the caller.
    return {
      approvedForType: 'CUSTOMER',
      approvedForTenantCompanyId: null,
      approvedForTenantPicId: null,
      approvedForName: request.customerName,
      approvedForCustomerName: request.customerName,
      approvedForCustomerPhone: request.customerPhone,
      approvedForCustomerEmail: request.customerEmail,
    };
  }

  if (input.type === 'TENANT_COMPANY') {
    const tenantCompanyId = (input as { tenantCompanyId?: unknown }).tenantCompanyId;
    if (typeof tenantCompanyId !== 'string' || !isValidUuid(tenantCompanyId)) {
      throw handymanQuotationApprovalForInvalidError(
        'approvedFor.tenantCompanyId is required for a TENANT_COMPANY decision.',
      );
    }
    if (!request.tenantCompanyId || tenantCompanyId !== request.tenantCompanyId) {
      throw handymanQuotationApprovalForInvalidError(
        'The approved-for tenant company is not the tenant company of this request.',
      );
    }
    const company = await tenantCompanyRepository.findById(tenantCompanyId);
    if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
      throw handymanQuotationApprovalForInvalidError(
        'The approved-for tenant company is not an ACTIVE company of this client.',
      );
    }
    const buildingContext = await tenantBuildingContextRepository.findActive(
      company.id,
      request.buildingId,
    );
    if (!buildingContext || !isEffectiveNow(buildingContext)) {
      throw handymanQuotationApprovalForInvalidError(
        'The approved-for tenant company has no ACTIVE effective building context for this request.',
      );
    }
    return {
      approvedForType: 'TENANT_COMPANY',
      approvedForTenantCompanyId: company.id,
      approvedForTenantPicId: null,
      approvedForName: company.tenantName,
      approvedForCustomerName: null,
      approvedForCustomerPhone: null,
      approvedForCustomerEmail: null,
    };
  }

  // TENANT_PIC
  const tenantPicId = (input as { tenantPicId?: unknown }).tenantPicId;
  if (typeof tenantPicId !== 'string' || !isValidUuid(tenantPicId)) {
    throw handymanQuotationApprovalForInvalidError(
      'approvedFor.tenantPicId is required for a TENANT_PIC decision.',
    );
  }
  if (!request.tenantPicId || tenantPicId !== request.tenantPicId) {
    throw handymanQuotationApprovalForInvalidError(
      'The approved-for tenant PIC is not the tenant PIC of this request.',
    );
  }
  const pic = await tenantPicRepository.findById(tenantPicId);
  if (!pic || pic.status !== 'ACTIVE') {
    throw handymanQuotationApprovalForInvalidError(
      'The approved-for tenant PIC is not ACTIVE.',
    );
  }
  if (!request.tenantCompanyId || pic.tenantCompanyId !== request.tenantCompanyId) {
    throw handymanQuotationApprovalForInvalidError(
      'The approved-for tenant PIC is not linked to the tenant company of this request.',
    );
  }
  const company = await tenantCompanyRepository.findById(pic.tenantCompanyId);
  if (!company || company.status !== 'ACTIVE' || company.clientId !== request.clientId) {
    throw handymanQuotationApprovalForInvalidError(
      'The tenant company of the approved-for PIC is not an ACTIVE company of this client.',
    );
  }
  return {
    approvedForType: 'TENANT_PIC',
    approvedForTenantCompanyId: company.id,
    approvedForTenantPicId: pic.id,
    approvedForName: pic.picName,
    approvedForCustomerName: null,
    approvedForCustomerPhone: null,
    approvedForCustomerEmail: null,
  };
}

/** Guarded, atomic, once-only decision + downstream transitions + event. */
async function applyDecision(
  context: DecidableContext,
  decision: HandymanQuotationApprovalDecision,
  method: 'IN_APP' | 'ASSISTED',
  approvedFor: Pick<
    ApprovalDecisionFields,
    | 'approvedForType'
    | 'approvedForTenantCompanyId'
    | 'approvedForTenantPicId'
    | 'approvedForName'
    | 'approvedForCustomerName'
    | 'approvedForCustomerPhone'
    | 'approvedForCustomerEmail'
  >,
  decisionNotes: string | null,
  recordedByUserId: string | null,
  actorUserId: string,
  tx: PoolClient,
): Promise<HandymanQuotationApprovalDecisionResult> {
  const decided = await handymanQuotationApprovalRepository.decideFromPending(
    context.approval.id,
    {
      status: decision,
      method,
      ...approvedFor,
      decisionNotes,
      recordedByUserId,
    },
    tx,
  );
  if (!decided) throw handymanQuotationApprovalNotPendingError(
    'A concurrent decision command won; this approval is no longer PENDING.',
  );

  const quotationStatus = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  const movedQuotation = await handymanQuotationRepository.markDecidedFromSent(
    context.quotation.id,
    quotationStatus,
    tx,
  );
  if (!movedQuotation) {
    throw handymanQuotationApprovalStateInvalidError(
      'A concurrent command already moved this quotation out of SENT.',
    );
  }

  const requestStatus = decision === 'APPROVED' ? 'APPROVED' : 'QUOTATION_REJECTED';
  const movedRequest = await handymanRequestRepository.updateStatusFrom(
    context.request.id,
    'QUOTATION_PENDING',
    requestStatus,
    tx,
  );
  if (!movedRequest) throw handymanRequestStatusInvalidError();

  await recordOperationalEvent(
    {
      clientId: context.quotation.clientId,
      buildingId: context.quotation.buildingId,
      eventType:
        decision === 'APPROVED'
          ? 'HANDYMAN_QUOTATION_APPROVED'
          : 'HANDYMAN_QUOTATION_REJECTED',
      entityType: 'HANDYMAN_QUOTATION_APPROVAL',
      entityId: decided.id,
      actorUserId,
      summary: `Quotation ${context.quotation.quotationNumber} ${decision.toLowerCase()} via ${method}.`,
      metadata: {
        approvalId: decided.id,
        method,
        approvedForType: decided.approvedForType,
        quotationId: context.quotation.id,
        quotationNumber: context.quotation.quotationNumber,
        revisionId: context.approval.quotationRevisionId,
        requestId: context.request.id,
        requestNumber: context.request.requestNumber,
        requestStatus,
        recordedByUserId,
      },
    },
    tx,
  );

  return {
    approval: toPublicHandymanQuotationApproval(decided),
    quotation: toPublicHandymanQuotation(movedQuotation),
    requestStatus,
  };
}

export async function decideHandymanQuotationApprovalInApp(
  input: DecideHandymanQuotationApprovalInAppInput,
  actorUserId: string,
): Promise<HandymanQuotationApprovalDecisionResult> {
  const decision = input.decision;
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw AppError.validation('Request validation failed.', [
      { field: 'decision', message: 'decision must be APPROVED or REJECTED.' },
    ]);
  }
  const notes = normalizeDecisionNotes(input.notes, { required: false });

  return withTransaction(async (tx) => {
    const context = await loadDecidableContext(input.quotationId, tx);
    // Actor identity comes ONLY from the authenticated session parameter and
    // must resolve to the tenant PIC authorized for this request.
    const pic = await resolveAuthorizedTenantPic(context.request, actorUserId);

    return applyDecision(
      context,
      decision,
      'IN_APP',
      {
        approvedForType: 'TENANT_PIC',
        approvedForTenantCompanyId: pic.companyId,
        approvedForTenantPicId: pic.picId,
        approvedForName: pic.picName,
        approvedForCustomerName: null,
        approvedForCustomerPhone: null,
        approvedForCustomerEmail: null,
      },
      notes,
      // Genuinely direct decision by the authorized tenant PIC — nobody
      // "recorded" it on their behalf.
      null,
      actorUserId,
      tx,
    );
  });
}

export async function recordHandymanQuotationApprovalAssistedDecision(
  input: RecordHandymanQuotationApprovalAssistedInput,
  actorUserId: string,
): Promise<HandymanQuotationApprovalDecisionResult> {
  const decision = input.decision;
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw AppError.validation('Request validation failed.', [
      { field: 'decision', message: 'decision must be APPROVED or REJECTED.' },
    ]);
  }
  if (
    !input.approvedFor ||
    typeof input.approvedFor !== 'object' ||
    !['TENANT_COMPANY', 'TENANT_PIC', 'CUSTOMER'].includes(
      (input.approvedFor as { type?: string }).type ?? '',
    )
  ) {
    throw handymanQuotationApprovalForInvalidError(
      'approvedFor must explicitly identify TENANT_COMPANY, TENANT_PIC, or CUSTOMER.',
    );
  }
  // Assisted decisions REQUIRE the out-of-band evidence trail.
  const notes = normalizeDecisionNotes(input.notes, { required: true });

  return withTransaction(async (tx) => {
    // Staff surface: governed building access (the seeded
    // handyman_quotation_approval.record permission is wired at the Run-4
    // HTTP/RBAC layer).
    const quotationProbe = await handymanQuotationRepository.findById(
      input.quotationId,
      tx,
    );
    if (!quotationProbe) {
      throw handymanQuotationApprovalStateInvalidError(
        'Handyman quotation not found.',
      );
    }
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      quotationProbe.buildingId,
    );

    const context = await loadDecidableContext(input.quotationId, tx);
    const approvedFor = await resolveApprovedFor(input.approvedFor, context.request);

    return applyDecision(
      context,
      decision,
      'ASSISTED',
      approvedFor,
      notes,
      // The authenticated staff actor is preserved SEPARATELY as the
      // recorder — never as the approved-for party.
      actorUserId,
      actorUserId,
      tx,
    );
  });
}

export async function getHandymanQuotationApproval(
  approvalId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationApproval> {
  return withTransaction(async (tx) => {
    if (!isValidUuid(approvalId)) throw handymanQuotationApprovalNotFoundError();
    const approval = await handymanQuotationApprovalRepository.findById(
      approvalId,
      tx,
    );
    if (!approval) throw handymanQuotationApprovalNotFoundError();
    await loadQuotationOrThrow(approval.quotationId, actorUserId, tx);
    return toPublicHandymanQuotationApproval(approval);
  });
}

export async function listHandymanQuotationApprovals(
  quotationId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationApproval[]> {
  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(quotationId, actorUserId, tx);
    const records = await handymanQuotationApprovalRepository.listByQuotation(
      quotation.id,
      tx,
    );
    return records.map(toPublicHandymanQuotationApproval);
  });
}

export const handymanQuotationApprovalService = {
  decideHandymanQuotationApprovalInApp,
  recordHandymanQuotationApprovalAssistedDecision,
  getHandymanQuotationApproval,
  listHandymanQuotationApprovals,
};
