import { AppError } from '../../shared/errors';
import {
  handymanQuotationLineRepository,
  handymanQuotationRepository,
} from '../handyman-quotations';
import { handymanQuotationApprovalBindingRepository as bindings } from '../handyman-quotation-approval-bindings';
import {
  picWorkspaceResourceNotFound,
  withPicWorkspaceSession,
  type PicWorkspacePrincipal,
} from '../handyman-pic-session';
import {
  evaluatePicApprovalEligibility,
  PIC_PORTAL_ELIGIBILITY_MESSAGES,
  type PicPortalEligibilityCode,
  type PublicPicPortalApprovalEligibility,
  type PublicPicPortalBinding,
  type PublicPicPortalDecision,
  type PublicPicPortalQuotationRead,
  type PublicPicPortalVersion,
} from './pic-portal.types';
import {
  findCurrentOccupancyStatus,
  findDecisionByVersion,
  findPresentedVersion,
  findRequestForCredential,
  findVersionForCredential,
  type PicPortalDecisionRow,
} from './pic-portal.repository';

/**
 * W03 PART 03D — the three reads of the bounded PIC portal (A01 §9, §13 `03D`).
 *
 * Every read in this file follows one shape, and the shape is the contract:
 *
 *   `withPicWorkspaceSession` (credential verified, and verified AGAIN after this
 *   transaction's own row locks) → resolve the thread FROM THE CREDENTIAL (tenant,
 *   building, space narrowing; never a caller claim) → read the presented version,
 *   its lines, the thread's binding and the recorded decision with `FOR SHARE` →
 *   project the minimum.
 *
 * There is no `actorUserId` anywhere, no permission lookup, and no staff scope
 * helper: a PIC principal has no local user, so borrowing `C6` would not merely be
 * wrong policy, it would be a type error. A thread outside the credential is
 * refused with the uniform 404 before any existence-bearing query runs, so
 * "not yours" and "does not exist" are the same answer and the same cost.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw AppError.validation('PIC portal read validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value.toLowerCase();
}

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/** Everything the two request-keyed reads need, loaded once, in one
 * transaction, behind the credential predicate. */
async function loadThreadContext(
  tx: Parameters<typeof findRequestForCredential>[0],
  principal: PicWorkspacePrincipal,
  handymanRequestId: string,
) {
  const request = await findRequestForCredential(tx, principal, handymanRequestId);
  if (!request) throw picWorkspaceResourceNotFound();

  const quotation = await handymanQuotationRepository.findQuotationByRequest(
    tx,
    request.requestId,
  );
  const presented = quotation
    ? await findPresentedVersion(tx, quotation.id)
    : null;
  const decision = presented
    ? await findDecisionByVersion(tx, presented.quotationVersionId)
    : null;
  const binding = quotation
    ? await bindings.findActiveBinding(tx, quotation.id)
    : null;
  const picFacts = principal.tenantPicId
    ? await bindings.findTenantPicFacts(tx, principal.tenantPicId)
    : null;
  const statuses = await bindings.findTenantCompanyAndClientStatuses(
    tx,
    request.tenantCompanyId,
    request.clientId,
  );
  const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const occupancyStatus = await findCurrentOccupancyStatus(tx, {
    tenantCompanyId: request.tenantCompanyId,
    buildingId: request.buildingId,
    at: clock.rows[0].now,
  });

  return {
    now: clock.rows[0].now,
    request,
    quotation: quotation ?? null,
    presented,
    decision,
    binding,
    picFacts,
    statuses,
    occupancyStatus,
  };
}

function projectDecision(
  row: PicPortalDecisionRow,
  principal: PicWorkspacePrincipal,
): PublicPicPortalDecision {
  return {
    quotationDecisionId: row.quotationDecisionId,
    decision: row.decision,
    decisionActorType: row.decisionActorType,
    decidedByTenantPicId: row.decidedByTenantPicId,
    decidedByPicSessionId: row.decidedByPicSessionId,
    approvalBindingId: row.approvalBindingId,
    decidedAt: iso(row.decidedAt) as string,
    // A boolean rather than a comparison the caller would have to redo: "was it
    // me" is a fact about this credential, and it must not require exposing
    // another PIC's identity to be answered.
    decidedByCaller:
      principal.tenantPicId !== null &&
      row.decidedByTenantPicId === principal.tenantPicId,
  };
}

function projectBinding(
  binding: NonNullable<Awaited<ReturnType<typeof bindings.findActiveBinding>>>,
): PublicPicPortalBinding {
  return {
    approvalBindingId: binding.id,
    status: binding.status,
    tenantPicId: binding.tenantPicId,
    bindingVersion: binding.bindingVersion,
    effectiveFrom: iso(binding.effectiveFrom) as string,
    effectiveUntil: iso(binding.effectiveUntil),
    grantedByUserId: binding.grantedByUserId,
  };
}

/** `GET /handyman/pic/requests/:handymanRequestId` — request + the presented
 * version's commercial facts + the thread's own authority state. */
export async function readPicPortalQuotation(
  token: string,
  handymanRequestIdInput: unknown,
): Promise<PublicPicPortalQuotationRead> {
  const handymanRequestId = uuid(handymanRequestIdInput, 'handymanRequestId');
  return withPicWorkspaceSession(token, async (tx, principal) => {
    const ctx = await loadThreadContext(tx, principal, handymanRequestId);
    let version: PublicPicPortalVersion | null = null;
    if (ctx.presented) {
      const lines = await handymanQuotationLineRepository.listLines(
        tx,
        ctx.presented.quotationVersionId,
      );
      const sums = await handymanQuotationLineRepository.sumLines(
        tx,
        ctx.presented.quotationVersionId,
      );
      const currency = await handymanQuotationLineRepository.findVersionCurrency(
        tx,
        ctx.presented.quotationVersionId,
      );
      version = {
        quotationVersionId: ctx.presented.quotationVersionId,
        versionNumber: ctx.presented.versionNumber,
        status: ctx.presented.status,
        validUntil: iso(ctx.presented.validUntil),
        lines: lines.map(line => ({
          id: line.id,
          lineType: line.lineType,
          description: line.description,
          quantity: line.quantity,
          uomId: line.uomId,
          finalQuotedUnitAmount: line.finalQuotedUnitAmount,
          lineTotal: line.lineTotal,
          currency: line.currency,
        })),
        totals: {
          laborSubtotal: sums.labor,
          materialSubtotal: sums.material,
          total: sums.labor + sums.material,
          currency,
          lineCount: sums.count,
        },
      };
    }
    return {
      handymanRequestId: ctx.request.requestId,
      tenantCompanyId: ctx.request.tenantCompanyId,
      buildingId: ctx.request.buildingId,
      spaceId: ctx.request.spaceId,
      requestStatus: ctx.request.requestStatus,
      serviceCatalogId: ctx.request.serviceCatalogId,
      serviceVariantId: ctx.request.serviceVariantId,
      description: ctx.request.description,
      quotation: ctx.quotation
        ? {
            quotationId: ctx.quotation.id,
            presentedVersion: version,
          }
        : null,
      decision: ctx.decision ? projectDecision(ctx.decision, principal) : null,
      approvalBinding: ctx.binding ? projectBinding(ctx.binding) : null,
      session: {
        sessionId: principal.sessionId,
        canDecide: principal.canDecide,
        expiresAt: principal.expiresAt,
      },
    };
  });
}

/**
 * `GET /handyman/pic/requests/:handymanRequestId/approval-eligibility` — a
 * read-only report of whether this credential could carry a decision on the
 * presented version right now, and if not, why.
 *
 * It loads the SAME context through the SAME predicate as the read above, so the
 * two can never disagree about which thread is being described. It writes nothing,
 * locks nothing that a decision does not already lock, and reserves nothing: see
 * `guaranteesDecision`.
 */
export async function readPicPortalApprovalEligibility(
  token: string,
  handymanRequestIdInput: unknown,
): Promise<PublicPicPortalApprovalEligibility> {
  const handymanRequestId = uuid(handymanRequestIdInput, 'handymanRequestId');
  return withPicWorkspaceSession(token, async (tx, principal) => {
    const ctx = await loadThreadContext(tx, principal, handymanRequestId);
    const reasons: PicPortalEligibilityCode[] = evaluatePicApprovalEligibility({
      now: ctx.now,
      canDecide: principal.canDecide,
      callerPicId: principal.tenantPicId,
      callerPicUserId: ctx.picFacts?.userId ?? null,
      lineageRequestPicId: ctx.request.lineageTenantPicId,
      tenantStatus: ctx.statuses.tenantStatus,
      clientStatus: ctx.statuses.clientStatus,
      occupancyStatus: ctx.occupancyStatus,
      binding: ctx.binding
        ? {
            tenantPicId: ctx.binding.tenantPicId,
            grantedByUserId: ctx.binding.grantedByUserId,
            effectiveFrom: ctx.binding.effectiveFrom,
            effectiveUntil: ctx.binding.effectiveUntil,
          }
        : null,
      version: ctx.presented
        ? {
            status: ctx.presented.status,
            validUntil: ctx.presented.validUntil,
            decisionRecorded: ctx.decision !== null,
            rootAuthorUserId: ctx.quotation?.createdByUserId ?? '',
            versionAuthorUserId: ctx.presented.versionAuthorUserId,
          }
        : null,
    });
    return {
      handymanRequestId: ctx.request.requestId,
      quotationId: ctx.quotation?.id ?? null,
      quotationVersionId: ctx.presented?.quotationVersionId ?? null,
      versionNumber: ctx.presented?.versionNumber ?? null,
      versionStatus: ctx.presented?.status ?? null,
      validUntil: iso(ctx.presented?.validUntil),
      decisionRecorded: ctx.decision !== null,
      lineageMatchesCaller:
        ctx.request.lineageTenantPicId === null ||
        ctx.request.lineageTenantPicId === principal.tenantPicId,
      canDecide: principal.canDecide,
      binding: ctx.binding
        ? {
            approvalBindingId: ctx.binding.id,
            status: ctx.binding.status,
            effectiveFrom: iso(ctx.binding.effectiveFrom) as string,
            effectiveUntil: iso(ctx.binding.effectiveUntil),
          }
        : null,
      eligible: reasons.length === 0,
      reasons: reasons.map(code => ({ code, message: PIC_PORTAL_ELIGIBILITY_MESSAGES[code] })),
      evaluatedAt: iso(ctx.now) as string,
      guaranteesDecision: false,
    };
  });
}

/**
 * `GET /handyman/pic/quotation-versions/:quotationVersionId/decision` — exact
 * read of the caller's OWN decision on one version (A01 §9).
 *
 * "Own" is enforced here rather than in a filter the caller could argue with: a
 * version that carries another PIC's decision, a version outside this credential's
 * thread, and a version that does not exist all answer with the same 404, so this
 * path cannot be used to discover who else decided what.
 */
export async function readPicPortalOwnDecision(
  token: string,
  quotationVersionIdInput: unknown,
): Promise<PublicPicPortalDecision> {
  const quotationVersionId = uuid(quotationVersionIdInput, 'quotationVersionId');
  return withPicWorkspaceSession(token, async (tx, principal) => {
    const version = await findVersionForCredential(
      tx,
      principal,
      quotationVersionId,
    );
    if (!version) throw picWorkspaceResourceNotFound();
    const decision = await findDecisionByVersion(tx, version.quotationVersionId);
    if (
      !decision ||
      principal.tenantPicId === null ||
      decision.decidedByTenantPicId !== principal.tenantPicId
    ) {
      throw picWorkspaceResourceNotFound();
    }
    return projectDecision(decision, principal);
  });
}
