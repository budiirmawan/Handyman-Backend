import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { rfqComparisonRepository } from '../rfq-comparisons/rfq-comparison.repository';
import { rfqRepository, type RfqRecord } from '../rfqs';
import { rfqRecommendationRepository } from './rfq-recommendation.repository';
import {
  rfqAwardAlreadyExistsError,
  rfqAwardNotFoundError,
  rfqAwardNotApprovedError,
  rfqAwardQuotationInvalidError,
  rfqAwardRecommendationInvalidError,
  rfqAwardRfqInvalidError,
  rfqRecommendationAlreadyExistsError,
  rfqRecommendationComparisonInvalidError,
  rfqRecommendationEvidenceInvalidError,
  rfqRecommendationNotFoundError,
  rfqRecommendationQuotationInvalidError,
  rfqRecommendationRfqInvalidError,
  rfqRecommendationStaleComparisonError,
} from './rfq-recommendation.errors';
import type {
  CreateRfqAwardInput,
  CreateRfqRecommendationInput,
  PublicRfqAward,
  PublicRfqRecommendation,
  RfqAwardRecord,
  RfqRecommendationRecord,
} from './rfq-recommendation.types';

const UNIQUE_VIOLATION = '23505';

type EvidenceRow = {
  id: string;
  comparisonRunId: string;
  rfqId: string;
  invitationId: string;
  quotationId: string;
  quotationRevisionId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  currency: string;
  validUntil: string | null;
};

type CurrentQuotationRow = {
  revisionId: string;
  quotationId: string;
  invitationId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  revisionStatus: string;
  quotationStatus: string;
  invitationStatus: string;
  currency: string;
  validUntil: string | null;
  submittedRevisionCount: string;
  vendorStatus: string;
  vendorBuildingActive: boolean;
};

type SourceStateRow = {
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineQuantity: string | number | null;
  lineUomId: string | null;
  materialStatus: string | null;
  materialApprovedQuantity: string | number | null;
  materialQuantity: string | number | null;
  materialUomId: string | null;
  serviceStatus: string | null;
};

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function toPublicRecommendation(record: RfqRecommendationRecord): PublicRfqRecommendation {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicAward(record: RfqAwardRecord): PublicRfqAward {
  return { ...record, awardedAt: record.awardedAt.toISOString() };
}

async function loadEvidence(
  client: PoolClient,
  comparisonRunId: string,
  evidenceId?: string,
  vendorId?: string,
  quotationRevisionId?: string,
): Promise<EvidenceRow> {
  const result = await client.query<EvidenceRow>(
    `SELECT id, comparison_run_id AS "comparisonRunId", rfq_id AS "rfqId",
            invitation_id AS "invitationId", quotation_id AS "quotationId",
            quotation_revision_id AS "quotationRevisionId", vendor_id AS "vendorId",
            client_id AS "clientId", building_id AS "buildingId", currency,
            valid_until::text AS "validUntil"
       FROM rfq_comparison_evidence
      WHERE comparison_run_id=$1
        AND ($2::uuid IS NULL OR id=$2)
        AND ($3::uuid IS NULL OR vendor_id=$3)
        AND ($4::uuid IS NULL OR quotation_revision_id=$4)
      ORDER BY id
      LIMIT 2`,
    [comparisonRunId, evidenceId ?? null, vendorId ?? null, quotationRevisionId ?? null],
  );
  if (result.rows.length !== 1) throw rfqRecommendationEvidenceInvalidError();
  return result.rows[0];
}

async function loadCurrentQuotation(
  client: PoolClient,
  evidence: EvidenceRow,
): Promise<CurrentQuotationRow | null> {
  const current = await client.query<CurrentQuotationRow>(
    `SELECT r.id AS "revisionId", q.id AS "quotationId", i.id AS "invitationId",
            r.vendor_id AS "vendorId", r.client_id AS "clientId", r.building_id AS "buildingId",
            r.status AS "revisionStatus", q.status AS "quotationStatus",
            i.status AS "invitationStatus", r.currency, r.valid_until::text AS "validUntil",
            (SELECT COUNT(*)::text FROM vendor_quotation_revisions r2
              WHERE r2.quotation_id=q.id AND r2.status='SUBMITTED') AS "submittedRevisionCount",
            v.status AS "vendorStatus",
            EXISTS (
              SELECT 1 FROM vendor_building_relationships vbr
               WHERE vbr.vendor_id=r.vendor_id AND vbr.building_id=r.building_id
                 AND vbr.status='ACTIVE'
                 AND (vbr.effective_from IS NULL OR vbr.effective_from <= NOW())
                 AND (vbr.effective_until IS NULL OR vbr.effective_until >= NOW())
            ) AS "vendorBuildingActive"
       FROM vendor_quotation_revisions r
       JOIN vendor_quotations q ON q.id=r.quotation_id
       JOIN rfq_vendor_invitations i ON i.id=q.invitation_id
       JOIN vendors v ON v.id=r.vendor_id
      WHERE q.id=$1 AND r.status='SUBMITTED'
      FOR UPDATE OF q, r, i, v`,
    [evidence.quotationId],
  );
  return current.rows[0] ?? null;
}

function assertCurrentQuotation(
  current: CurrentQuotationRow | null,
  evidence: EvidenceRow,
  rfq: RfqRecord,
  staleError: () => Error,
  invalidError: () => Error,
): void {
  if (!current || current.revisionId !== evidence.quotationRevisionId
    || Number(current.submittedRevisionCount) !== 1) throw staleError();
  if (current.quotationId !== evidence.quotationId || current.invitationId !== evidence.invitationId
    || current.vendorId !== evidence.vendorId || current.clientId !== rfq.clientId
    || current.buildingId !== rfq.buildingId || current.currency !== rfq.currency
    || current.revisionStatus !== 'SUBMITTED' || current.quotationStatus !== 'SUBMITTED'
    || current.invitationStatus !== 'QUOTATION_SUBMITTED' || current.vendorStatus !== 'ACTIVE'
    || !current.vendorBuildingActive || !current.validUntil
    || current.validUntil < new Date().toISOString().slice(0, 10)) {
    throw invalidError();
  }
}

async function assertSourceStillValid(client: PoolClient, rfq: RfqRecord): Promise<void> {
  const request = await client.query<{ status: string }>('SELECT status FROM purchase_requests WHERE id=$1 FOR UPDATE', [rfq.purchaseRequestId]);
  if (!request.rows[0] || request.rows[0].status !== 'OPEN') throw rfqAwardRfqInvalidError();
  const sources = await client.query<SourceStateRow>(
    `SELECT l.source_mode AS "sourceMode", l.quantity_snapshot AS "lineQuantity",
            l.source_uom_id AS "lineUomId", mr.status AS "materialStatus",
            mr.approved_quantity AS "materialApprovedQuantity", mr.quantity AS "materialQuantity",
            mr.uom_id AS "materialUomId", sr.status AS "serviceStatus"
       FROM rfq_lines l
       LEFT JOIN material_requests mr ON mr.id=l.material_request_id
       LEFT JOIN service_requests sr ON sr.id=l.service_request_id
      WHERE l.rfq_id=$1
      ORDER BY l.line_number
      FOR UPDATE OF l`,
    [rfq.id],
  );
  if (sources.rows.length === 0) throw rfqAwardRfqInvalidError();
  for (const source of sources.rows) {
    if (source.sourceMode === 'MATERIAL') {
      const currentQuantity = source.materialApprovedQuantity ?? source.materialQuantity;
      if (source.materialStatus === 'CANCELLED' || currentQuantity === null
        || Number(currentQuantity) !== Number(source.lineQuantity)
        || source.materialUomId !== source.lineUomId) throw rfqAwardRfqInvalidError();
    } else if (source.serviceStatus === 'CANCELLED' || source.serviceStatus === null) {
      throw rfqAwardRfqInvalidError();
    }
  }
}

async function requireAccessibleRecommendation(id: string, actorUserId: string): Promise<RfqRecommendationRecord> {
  const recommendation = await rfqRecommendationRepository.findRecommendationById(id);
  if (!recommendation) throw rfqRecommendationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, recommendation.buildingId);
  return recommendation;
}

export async function createRfqRecommendation(
  input: CreateRfqRecommendationInput,
  actorUserId: string,
): Promise<PublicRfqRecommendation> {
  const initial = await rfqRepository.findById(input.rfqId);
  if (!initial) throw rfqRecommendationRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, initial.buildingId);

  const created = await withTransaction(async (client) => {
    const rfq = await rfqRepository.findByIdForUpdate(client, input.rfqId);
    if (!rfq || rfq.status !== 'CLOSED') throw rfqRecommendationRfqInvalidError();
    const run = await rfqComparisonRepository.findRunByIdForUpdate(client, input.comparisonRunId);
    if (!run || run.rfqId !== rfq.id || run.clientId !== rfq.clientId || run.buildingId !== rfq.buildingId || run.status !== 'SNAPSHOT') {
      throw rfqRecommendationComparisonInvalidError();
    }
    const existing = await rfqRecommendationRepository.findRecommendationByRfqForUpdate(client, rfq.id);
    if (existing) throw rfqRecommendationAlreadyExistsError();

    let evidence: EvidenceRow | null = null;
    const outcome = input.outcome ?? 'VENDOR';
    if (outcome === 'VENDOR') {
      evidence = await loadEvidence(client, run.id, input.evidenceId, input.vendorId, input.quotationRevisionId);
      if (evidence.rfqId !== rfq.id || evidence.clientId !== rfq.clientId || evidence.buildingId !== rfq.buildingId || evidence.currency !== rfq.currency) {
        throw rfqRecommendationEvidenceInvalidError();
      }
      const current = await loadCurrentQuotation(client, evidence);
      assertCurrentQuotation(current, evidence, rfq, rfqRecommendationStaleComparisonError, rfqRecommendationQuotationInvalidError);
    } else if (input.evidenceId || input.vendorId || input.quotationRevisionId) {
      throw rfqRecommendationEvidenceInvalidError();
    }

    try {
      const recommendation = await rfqRecommendationRepository.createRecommendationWithClient(client, {
        rfqId: rfq.id,
        clientId: rfq.clientId,
        buildingId: rfq.buildingId,
        comparisonRunId: run.id,
        evidenceId: evidence?.id ?? null,
        quotationId: evidence?.quotationId ?? null,
        quotationRevisionId: evidence?.quotationRevisionId ?? null,
        invitationId: evidence?.invitationId ?? null,
        vendorId: evidence?.vendorId ?? null,
        outcome,
        reason: input.reason,
        notes: input.notes ?? null,
        createdByUserId: actorUserId,
      });
      await recordOperationalEvent({
        clientId: rfq.clientId,
        buildingId: rfq.buildingId,
        eventType: 'RFQ_RECOMMENDATION_CREATED',
        entityType: 'RFQ_RECOMMENDATION',
        entityId: recommendation.id,
        actorUserId,
        summary: 'Human RFQ recommendation created for approval.',
        metadata: {
          rfqId: rfq.id,
          recommendationId: recommendation.id,
          comparisonRunId: run.id,
          evidenceId: evidence?.id,
          quotationRevisionId: evidence?.quotationRevisionId,
          vendorId: evidence?.vendorId,
          outcome,
        },
      }, client);
      return recommendation;
    } catch (error) {
      if (uniqueConstraint(error) === 'rfq_recommendations_one_per_rfq_unique') throw rfqRecommendationAlreadyExistsError();
      throw error;
    }
  });
  return toPublicRecommendation(created);
}

export async function getRfqRecommendation(id: string, actorUserId: string): Promise<PublicRfqRecommendation> {
  return toPublicRecommendation(await requireAccessibleRecommendation(id, actorUserId));
}

export async function getRfqRecommendationForRfq(rfqId: string, actorUserId: string): Promise<PublicRfqRecommendation | null> {
  const rfq = await rfqRepository.findById(rfqId);
  if (!rfq) throw rfqRecommendationRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, rfq.buildingId);
  const recommendation = await rfqRecommendationRepository.findRecommendationByRfq(rfqId);
  return recommendation ? toPublicRecommendation(recommendation) : null;
}

export async function getRfqAward(id: string, actorUserId: string): Promise<PublicRfqAward> {
  const award = await rfqRecommendationRepository.findAwardById(id);
  if (!award) throw rfqAwardNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, award.buildingId);
  return toPublicAward(award);
}

async function findApprovedAwardApproval(client: PoolClient, recommendation: RfqRecommendationRecord): Promise<{ id: string } | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM procurement_approval_bindings
      WHERE request_type='RFQ' AND rfq_id=$1 AND recommendation_id=$2
        AND approval_type='RFQ_AWARD' AND status='APPROVED'
      ORDER BY decided_at, id
      LIMIT 2`,
    [recommendation.rfqId, recommendation.id],
  );
  if (result.rows.length > 1) throw rfqAwardRecommendationInvalidError();
  return result.rows[0] ?? null;
}

export async function awardRfqRecommendation(
  input: CreateRfqAwardInput,
  actorUserId: string,
): Promise<PublicRfqAward> {
  const initial = await requireAccessibleRecommendation(input.recommendationId, actorUserId);
  const award = await withTransaction(async (client) => {
    const recommendation = await rfqRecommendationRepository.findRecommendationByIdForUpdate(client, initial.id);
    if (!recommendation) throw rfqRecommendationNotFoundError();
    const rfq = await rfqRepository.findByIdForUpdate(client, recommendation.rfqId);
    if (!rfq || rfq.status !== 'CLOSED') throw rfqAwardRfqInvalidError();
    const existingAward = await rfqRecommendationRepository.findAwardByRfqForUpdate(client, rfq.id);
    if (existingAward) throw rfqAwardAlreadyExistsError();
    if (recommendation.status !== 'APPROVED') throw rfqAwardNotApprovedError();
    const approval = await findApprovedAwardApproval(client, recommendation);
    if (!approval) throw rfqAwardNotApprovedError();
    await assertSourceStillValid(client, rfq);

    let evidence: EvidenceRow | null = null;
    if (recommendation.outcome === 'VENDOR') {
      evidence = await loadEvidence(client, recommendation.comparisonRunId, recommendation.evidenceId!, recommendation.vendorId!, recommendation.quotationRevisionId!);
      const current = await loadCurrentQuotation(client, evidence);
      assertCurrentQuotation(current, evidence, rfq, rfqAwardQuotationInvalidError, rfqAwardQuotationInvalidError);
    }

    let created: RfqAwardRecord;
    try {
      created = await rfqRecommendationRepository.createAwardWithClient(client, {
        rfqId: rfq.id,
        clientId: rfq.clientId,
        buildingId: rfq.buildingId,
        recommendationId: recommendation.id,
        approvalId: approval.id,
        comparisonRunId: recommendation.comparisonRunId,
        evidenceId: evidence?.id ?? null,
        quotationId: evidence?.quotationId ?? null,
        quotationRevisionId: evidence?.quotationRevisionId ?? null,
        invitationId: evidence?.invitationId ?? null,
        vendorId: evidence?.vendorId ?? null,
        outcome: recommendation.outcome,
        awardReason: input.awardReason ?? null,
        awardedByUserId: actorUserId,
      });
    } catch (error) {
      if (uniqueConstraint(error) === 'rfq_awards_one_per_rfq_unique' || uniqueConstraint(error) === 'rfq_awards_one_per_recommendation_unique') {
        throw rfqAwardAlreadyExistsError();
      }
      throw error;
    }
    const updated = await rfqRecommendationRepository.updateRecommendationStatusWithClient(client, recommendation.id, 'APPROVED', 'AWARDED');
    if (!updated) throw rfqAwardRecommendationInvalidError();
    await recordOperationalEvent({
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      eventType: recommendation.outcome === 'NO_AWARD' ? 'RFQ_NO_AWARD_FINALIZED' : 'RFQ_AWARD_FINALIZED',
      entityType: 'RFQ_AWARD',
      entityId: created.id,
      actorUserId,
      summary: recommendation.outcome === 'NO_AWARD' ? 'RFQ finalized with no award.' : 'RFQ Vendor award finalized.',
      metadata: {
        rfqId: rfq.id,
        awardId: created.id,
        recommendationId: recommendation.id,
        approvalId: approval.id,
        comparisonRunId: recommendation.comparisonRunId,
        evidenceId: evidence?.id,
        quotationRevisionId: evidence?.quotationRevisionId,
        vendorId: evidence?.vendorId,
        outcome: recommendation.outcome,
      },
    }, client);
    return created;
  });
  return toPublicAward(award);
}

export const rfqRecommendationService = {
  awardRfqRecommendation,
  createRfqRecommendation,
  getRfqAward,
  getRfqRecommendation,
  getRfqRecommendationForRfq,
};
