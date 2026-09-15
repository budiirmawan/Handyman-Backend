import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { purchaseOrderLineRepository } from '../purchase-orders/purchase-order-line.repository';
import { deriveLineAmount } from '../purchase-orders/purchase-order-line.types';
import { purchaseOrderNumberExistsError } from '../purchase-orders/purchase-order.errors';
import { purchaseOrderRepository } from '../purchase-orders/purchase-order.repository';
import type { PublicPurchaseOrder, PurchaseOrderRecord } from '../purchase-orders/purchase-order.types';
import { rfqRepository, type RfqRecord } from '../rfqs';
import { rfqRecommendationRepository } from '../rfq-recommendations/rfq-recommendation.repository';
import type { RfqAwardRecord } from '../rfq-recommendations/rfq-recommendation.types';
import { rfqPoProvenanceRepository } from './rfq-po-provenance.repository';
import {
  rfqPoConversionAlreadyExistsError,
  rfqPoConversionAwardInvalidError,
  rfqPoConversionCurrencyInvalidError,
  rfqPoConversionIdempotencyConflictError,
  rfqPoConversionLineInvalidError,
  rfqPoConversionNotFoundError,
  rfqPoConversionReadinessInvalidError,
  rfqPoConversionScopeInvalidError,
} from './rfq-po-conversion.errors';
import type {
  CreateRfqPoConversionInput,
  PublicRfqPoConversion,
  RfqAwardPoConversionRecord,
} from './rfq-po-conversion.types';

const UNIQUE_VIOLATION = '23505';

type AwardedQuotation = {
  revisionId: string;
  quotationId: string;
  invitationId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  currency: string;
  validUntil: string | null;
  revisionStatus: string;
  quotationStatus: string;
  invitationStatus: string;
  submittedRevisionCount: string;
  vendorStatus: string;
  vendorBuildingActive: boolean;
};

type ConversionLine = {
  rfqLineId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumber: number;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  /** CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated to the PO line. */
  sourceServiceId: string | null;
  quantitySnapshot: string | number | null;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  materialStatus: string | null;
  materialQuantity: string | number | null;
  materialApprovedQuantity: string | number | null;
  materialItemId: string | null;
  materialUomId: string | null;
  serviceStatus: string | null;
  quotationLineId: string;
  quotationRevisionId: string;
  quotationId: string;
  quotationRfqId: string;
  quoteSourceMode: 'MATERIAL' | 'SERVICE';
  quoteLineNumber: number;
  offeredDescription: string | null;
  unitPrice: string | number;
  lineTotal: string | number;
};

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function fingerprint(input: CreateRfqPoConversionInput): string {
  return createHash('sha256').update(JSON.stringify({
    awardId: input.awardId,
    poReadinessId: input.poReadinessId,
    poNumber: input.poNumber,
    poDate: input.poDate,
    notes: input.notes ?? null,
  })).digest('hex');
}

function toPublicPurchaseOrder(record: PurchaseOrderRecord): PublicPurchaseOrder {
  return {
    ...record,
    issuedAt: record.issuedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicConversion(
  conversion: RfqAwardPoConversionRecord,
  purchaseOrder: PurchaseOrderRecord,
  purchaseOrderLines: Awaited<ReturnType<typeof purchaseOrderLineRepository.listByPurchaseOrder>>,
  lineProvenance: Awaited<ReturnType<typeof rfqPoProvenanceRepository.listLineProvenance>>,
): PublicRfqPoConversion {
  return {
    id: conversion.id,
    awardId: conversion.awardId,
    recommendationId: conversion.recommendationId,
    rfqId: conversion.rfqId,
    clientId: conversion.clientId,
    buildingId: conversion.buildingId,
    comparisonRunId: conversion.comparisonRunId,
    evidenceId: conversion.evidenceId,
    quotationId: conversion.quotationId,
    quotationRevisionId: conversion.quotationRevisionId,
    invitationId: conversion.invitationId,
    vendorId: conversion.vendorId,
    poReadinessId: conversion.poReadinessId,
    purchaseOrderId: conversion.purchaseOrderId,
    convertedByUserId: conversion.convertedByUserId,
    convertedAt: conversion.convertedAt.toISOString(),
    purchaseOrder: toPublicPurchaseOrder(purchaseOrder),
    purchaseOrderLines: purchaseOrderLines.map((line) => ({
      ...line,
      createdAt: line.createdAt.toISOString(),
      updatedAt: line.updatedAt.toISOString(),
    })),
    lineProvenance: lineProvenance.map((line) => ({
      ...line,
      createdAt: line.createdAt.toISOString(),
    })),
  };
}

async function loadPublicConversion(conversion: RfqAwardPoConversionRecord): Promise<PublicRfqPoConversion> {
  const purchaseOrder = await purchaseOrderRepository.findById(conversion.purchaseOrderId);
  if (!purchaseOrder) throw rfqPoConversionNotFoundError();
  const [lines, lineProvenance] = await Promise.all([
    purchaseOrderLineRepository.listByPurchaseOrder(conversion.purchaseOrderId),
    rfqPoProvenanceRepository.listLineProvenance(conversion.id),
  ]);
  return toPublicConversion(conversion, purchaseOrder, lines, lineProvenance);
}

async function loadAwardForUpdate(client: PoolClient, id: string): Promise<RfqAwardRecord | null> {
  return rfqRecommendationRepository.findAwardByIdForUpdate(client, id);
}

async function assertAwardEvidence(client: PoolClient, award: RfqAwardRecord, rfq: RfqRecord): Promise<void> {
  const result = await client.query<{
    rfqId: string;
    quotationId: string;
    quotationRevisionId: string;
    vendorId: string;
    clientId: string;
    buildingId: string;
  }>(
    `SELECT rfq_id AS "rfqId", quotation_id AS "quotationId",
            quotation_revision_id AS "quotationRevisionId", vendor_id AS "vendorId",
            client_id AS "clientId", building_id AS "buildingId"
       FROM rfq_comparison_evidence
      WHERE id=$1 AND comparison_run_id=$2
      FOR UPDATE`,
    [award.evidenceId, award.comparisonRunId],
  );
  const evidence = result.rows[0];
  if (!evidence || evidence.rfqId !== rfq.id || evidence.quotationId !== award.quotationId
    || evidence.quotationRevisionId !== award.quotationRevisionId || evidence.vendorId !== award.vendorId
    || evidence.clientId !== rfq.clientId || evidence.buildingId !== rfq.buildingId) {
    throw rfqPoConversionAwardInvalidError();
  }
}

async function loadAwardedQuotation(client: PoolClient, award: RfqAwardRecord): Promise<AwardedQuotation | null> {
  const result = await client.query<AwardedQuotation>(
    `SELECT r.id AS "revisionId", q.id AS "quotationId", i.id AS "invitationId",
            r.vendor_id AS "vendorId", r.client_id AS "clientId", r.building_id AS "buildingId",
            r.currency, r.valid_until::text AS "validUntil", r.status AS "revisionStatus",
            q.status AS "quotationStatus", i.status AS "invitationStatus",
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
    [award.quotationId],
  );
  return result.rows[0] ?? null;
}

function assertAwardScope(award: RfqAwardRecord, rfq: RfqRecord): void {
  if (award.rfqId !== rfq.id || award.clientId !== rfq.clientId || award.buildingId !== rfq.buildingId
    || award.outcome !== 'VENDOR' || !award.evidenceId || !award.quotationId
    || !award.quotationRevisionId || !award.invitationId || !award.vendorId) {
    throw rfqPoConversionAwardInvalidError();
  }
}

function assertAwardedQuotation(
  quotation: AwardedQuotation | null,
  award: RfqAwardRecord,
  rfq: RfqRecord,
): void {
  if (!quotation || quotation.revisionId !== award.quotationRevisionId
    || quotation.quotationId !== award.quotationId || quotation.invitationId !== award.invitationId
    || quotation.vendorId !== award.vendorId || quotation.clientId !== rfq.clientId
    || quotation.buildingId !== rfq.buildingId || quotation.currency !== rfq.currency
    || quotation.revisionStatus !== 'SUBMITTED' || quotation.quotationStatus !== 'SUBMITTED'
    || quotation.invitationStatus !== 'QUOTATION_SUBMITTED'
    || Number(quotation.submittedRevisionCount) !== 1
    || quotation.vendorStatus !== 'ACTIVE' || !quotation.vendorBuildingActive
    || !quotation.validUntil || quotation.validUntil < new Date().toISOString().slice(0, 10)) {
    throw rfqPoConversionAwardInvalidError();
  }
}

async function loadConversionLines(client: PoolClient, award: RfqAwardRecord): Promise<ConversionLine[]> {
  const result = await client.query<ConversionLine>(
    `SELECT l.id AS "rfqLineId", l.source_mode AS "sourceMode", l.line_number AS "lineNumber",
            l.source_description AS "sourceDescription", l.source_item_id AS "sourceItemId",
            l.source_uom_id AS "sourceUomId", l.source_service_id AS "sourceServiceId",
            l.quantity_snapshot AS "quantitySnapshot",
            l.material_request_id AS "materialRequestId", l.service_request_id AS "serviceRequestId",
            mr.status AS "materialStatus", mr.quantity AS "materialQuantity",
            mr.approved_quantity AS "materialApprovedQuantity", mr.item_id AS "materialItemId",
            mr.uom_id AS "materialUomId", sr.status AS "serviceStatus",
            ql.id AS "quotationLineId",
            ql.quotation_revision_id AS "quotationRevisionId", ql.quotation_id AS "quotationId",
            ql.rfq_id AS "quotationRfqId", ql.source_mode AS "quoteSourceMode",
            ql.line_number_snapshot AS "quoteLineNumber", ql.description AS "offeredDescription",
            ql.unit_price AS "unitPrice", ql.line_total AS "lineTotal"
       FROM rfq_lines l
       LEFT JOIN material_requests mr ON mr.id=l.material_request_id
       LEFT JOIN service_requests sr ON sr.id=l.service_request_id
       LEFT JOIN vendor_quotation_lines ql
         ON ql.rfq_line_id=l.id AND ql.quotation_revision_id=$2
      WHERE l.rfq_id=$1
      ORDER BY l.line_number, l.id`,
    [award.rfqId, award.quotationRevisionId],
  );
  return result.rows;
}

function assertAndMapLines(lines: ConversionLine[], rfq: RfqRecord, award: RfqAwardRecord): ConversionLine[] {
  if (lines.length === 0 || lines.some((line) => !line.quotationLineId) || lines.length !== new Set(lines.map((line) => line.rfqLineId)).size) {
    throw rfqPoConversionLineInvalidError();
  }
  for (const line of lines) {
    if (line.sourceMode !== rfq.sourceMode || line.quotationRevisionId !== award.quotationRevisionId
      || line.quotationId !== award.quotationId || line.quotationRfqId !== rfq.id
      || line.quoteSourceMode !== line.sourceMode || line.quoteLineNumber !== line.lineNumber) {
      throw rfqPoConversionLineInvalidError();
    }
    if (line.sourceMode === 'MATERIAL') {
      const currentQuantity = line.materialApprovedQuantity ?? line.materialQuantity;
      if (!line.materialRequestId || line.serviceRequestId || line.materialStatus === 'CANCELLED'
        || currentQuantity === null || Number(currentQuantity) !== Number(line.quantitySnapshot)
        || line.materialItemId !== line.sourceItemId || line.materialUomId !== line.sourceUomId) throw rfqPoConversionLineInvalidError();
    } else if (!line.serviceRequestId || line.materialRequestId || line.serviceStatus !== 'OPEN') {
      throw rfqPoConversionLineInvalidError();
    }
  }
  return lines;
}

async function assertReadiness(
  client: PoolClient,
  poReadinessId: string,
  rfq: RfqRecord,
  award: RfqAwardRecord,
): Promise<{ id: string }> {
  const result = await client.query<{
    id: string;
    clientId: string;
    buildingId: string;
    requestType: string;
    purchaseRequestId: string | null;
    serviceRequestId: string | null;
    vendorId: string;
    readiness: string;
  }>(
    `SELECT id, client_id AS "clientId", building_id AS "buildingId",
            request_type AS "requestType", purchase_request_id AS "purchaseRequestId",
            service_request_id AS "serviceRequestId", vendor_id AS "vendorId", readiness
       FROM purchase_order_readiness
      WHERE id=$1
      FOR UPDATE`,
    [poReadinessId],
  );
  const readiness = result.rows[0];
  if (!readiness || readiness.readiness !== 'READY' || readiness.requestType !== 'PURCHASE_REQUEST'
    || readiness.purchaseRequestId !== rfq.purchaseRequestId || readiness.serviceRequestId !== null
    || readiness.vendorId !== award.vendorId || readiness.clientId !== rfq.clientId
    || readiness.buildingId !== rfq.buildingId) throw rfqPoConversionReadinessInvalidError();
  return readiness;
}

export async function createRfqPoConversion(
  input: CreateRfqPoConversionInput,
  actorUserId: string,
): Promise<PublicRfqPoConversion> {
  const initialAward = await rfqRecommendationRepository.findAwardById(input.awardId);
  if (!initialAward) throw rfqPoConversionAwardInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, initialAward.buildingId);
  const expectedFingerprint = fingerprint(input);

  const conversion = await withTransaction(async (client) => {
    const award = await loadAwardForUpdate(client, input.awardId);
    if (!award) throw rfqPoConversionAwardInvalidError();
    const rfq = await rfqRepository.findByIdForUpdate(client, award.rfqId);
    if (!rfq || rfq.status !== 'CLOSED') throw rfqPoConversionAwardInvalidError();
    assertAwardScope(award, rfq);
    await assertAwardEvidence(client, award, rfq);

    const existing = await rfqPoProvenanceRepository.findConversionByAwardForUpdate(client, award.id);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) throw rfqPoConversionAlreadyExistsError();
      if (existing.idempotencyFingerprint !== expectedFingerprint) throw rfqPoConversionIdempotencyConflictError();
      return existing;
    }

    const readiness = await assertReadiness(client, input.poReadinessId, rfq, award);
    const quotation = await loadAwardedQuotation(client, award);
    assertAwardedQuotation(quotation, award, rfq);
    if (!quotation || quotation.currency !== rfq.currency) {
      throw rfqPoConversionCurrencyInvalidError();
    }
    await assertActiveAllowedCurrency(rfq.clientId, quotation.currency);
    const lines = assertAndMapLines(await loadConversionLines(client, award), rfq, award);

    let po: PurchaseOrderRecord;
    try {
      po = await purchaseOrderRepository.createWithClient(client, {
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      poNumber: input.poNumber,
      poDate: input.poDate,
      vendorId: award.vendorId!,
      requestType: 'PURCHASE_REQUEST',
      purchaseRequestId: rfq.purchaseRequestId,
      serviceRequestId: null,
      poReadinessId: readiness.id,
      currency: quotation.currency as PurchaseOrderRecord['currency'],
      status: 'DRAFT',
      vendorReference: await quotationNumber(client, award.quotationId!),
      requiredDate: rfq.requiredDate?.toISOString().slice(0, 10) ?? null,
      notes: input.notes ?? null,
      createdByUserId: actorUserId,
      });
    } catch (error) {
      if (uniqueConstraint(error) === 'purchase_orders_client_number_unique') throw purchaseOrderNumberExistsError();
      throw error;
    }

    const createdLines: Array<{ poLineId: string; rfqLineId: string; quotationLineId: string }> = [];
    for (const line of lines) {
      const material = line.sourceMode === 'MATERIAL';
      const quantity = material ? Number(line.materialApprovedQuantity ?? line.materialQuantity) : null;
      const requestLineId = material ? line.materialRequestId! : line.serviceRequestId!;
      const existingLine = await purchaseOrderLineRepository.findLiveCommitmentForRequestLine(
        material ? requestLineId : null,
        material ? null : requestLineId,
      );
      if (existingLine) throw rfqPoConversionLineInvalidError();
      const poLine = await purchaseOrderLineRepository.createWithClient(client, {
        purchaseOrderId: po.id,
        clientId: rfq.clientId,
        buildingId: rfq.buildingId,
        requestLineType: material ? 'MATERIAL_REQUEST' : 'SERVICE_REQUEST',
        materialRequestId: material ? requestLineId : null,
        serviceRequestId: material ? null : requestLineId,
        itemId: material ? line.sourceItemId : null,
        uomId: material ? line.sourceUomId : null,
        // CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated from the
        // RFQ line. NULL for MATERIAL and un-governed SERVICE lines.
        sourceServiceId: material ? null : (line.sourceServiceId ?? null),
        description: line.offeredDescription?.trim() || line.sourceDescription,
        quantitySnapshot: quantity,
        unitPrice: Number(line.unitPrice),
        lineAmount: deriveLineAmount(quantity, Number(line.unitPrice)),
        notes: null,
        createdByUserId: actorUserId,
      });
      createdLines.push({ poLineId: poLine.id, rfqLineId: line.rfqLineId, quotationLineId: line.quotationLineId });
    }

    const created = await rfqPoProvenanceRepository.createConversionWithClient(client, {
      awardId: award.id,
      recommendationId: award.recommendationId,
      rfqId: rfq.id,
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      comparisonRunId: award.comparisonRunId,
      evidenceId: award.evidenceId!,
      quotationId: award.quotationId!,
      quotationRevisionId: award.quotationRevisionId!,
      invitationId: award.invitationId!,
      vendorId: award.vendorId!,
      poReadinessId: readiness.id,
      purchaseOrderId: po.id,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: expectedFingerprint,
      convertedByUserId: actorUserId,
    });
    for (const line of createdLines) {
      await rfqPoProvenanceRepository.createLineProvenanceWithClient(client, {
        conversionId: created.id,
        purchaseOrderId: po.id,
        purchaseOrderLineId: line.poLineId,
        rfqId: rfq.id,
        rfqLineId: line.rfqLineId,
        quotationLineId: line.quotationLineId,
        quotationRevisionId: award.quotationRevisionId!,
      });
    }
    await recordOperationalEvent({
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      eventType: 'RFQ_PO_CONVERSION_CREATED',
      entityType: 'RFQ_PO_CONVERSION',
      entityId: created.id,
      actorUserId,
      summary: 'Finalized RFQ award converted to an existing DRAFT Purchase Order.',
      metadata: {
        rfqId: rfq.id,
        awardId: award.id,
        recommendationId: award.recommendationId,
        comparisonRunId: award.comparisonRunId,
        evidenceId: award.evidenceId,
        quotationId: award.quotationId,
        quotationRevisionId: award.quotationRevisionId,
        vendorId: award.vendorId!,
        poReadinessId: readiness.id,
        purchaseOrderId: po.id,
        purchaseOrderLineIds: createdLines.map((line) => line.poLineId),
      },
    }, client);
    return created;
  });
  return loadPublicConversion(conversion);
}

async function quotationNumber(client: PoolClient, quotationId: string): Promise<string> {
  const result = await client.query<{ quotationNumber: string }>('SELECT quotation_number AS "quotationNumber" FROM vendor_quotations WHERE id=$1 FOR UPDATE', [quotationId]);
  return result.rows[0]?.quotationNumber ?? quotationId;
}

export async function getRfqPoConversion(id: string, actorUserId: string): Promise<PublicRfqPoConversion> {
  const conversion = await rfqPoProvenanceRepository.findConversionById(id);
  if (!conversion) throw rfqPoConversionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, conversion.buildingId);
  return loadPublicConversion(conversion);
}

export async function getRfqPoProvenanceForPurchaseOrder(poId: string, actorUserId: string): Promise<PublicRfqPoConversion> {
  const conversion = await rfqPoProvenanceRepository.findConversionByPurchaseOrder(poId);
  if (!conversion) throw rfqPoConversionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, conversion.buildingId);
  return loadPublicConversion(conversion);
}

export const rfqPoConversionService = {
  createRfqPoConversion,
  getRfqPoConversion,
  getRfqPoProvenanceForPurchaseOrder,
};
